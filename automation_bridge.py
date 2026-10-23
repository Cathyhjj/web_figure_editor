"""In-memory rendezvous between local MCP clients and live editor pages."""
import secrets
import threading
import time

MAX_AUTOMATION_BODY = 36 * 1024 * 1024
METHODS = {"get_state", "batch_edit", "preview", "export", "history", "save"}


class AutomationError(Exception):
    def __init__(self, status, message):
        self.status = status
        super().__init__(message)


def fields(value, allowed, required=()):
    if not isinstance(value, dict) or set(value) - set(allowed) or set(required) - set(value):
        raise AutomationError(400, "Invalid automation request fields.")


def summary(value):
    fields(value, {"name", "projectId", "slideId", "revision"})
    if any(not isinstance(v, str) or len(v) > 300 for v in value.values()):
        raise AutomationError(400, "Invalid page summary.")
    return dict(value)


class AutomationBridge:
    def __init__(self, *, command_timeout=45, poll_timeout=10, session_timeout=60):
        self.condition = threading.Condition()
        self.sessions = {}
        self.command_timeout = command_timeout
        self.poll_timeout = poll_timeout
        self.session_timeout = session_timeout

    def _prune(self):
        now = time.monotonic()
        for key, session in list(self.sessions.items()):
            if now - session["seen"] > self.session_timeout:
                del self.sessions[key]
        self.condition.notify_all()

    def _session(self, identifier):
        if not isinstance(identifier, str) or identifier not in self.sessions:
            raise AutomationError(404, "Page disconnected or expired. List sessions and read state again.")
        return self.sessions[identifier]

    def handle(self, action, data):
        if action == "command":
            return self.command(data)
        with self.condition:
            self._prune()
            if action == "register":
                fields(data, {"summary"}, {"summary"})
                metadata = summary(data["summary"])
                if len(self.sessions) >= 32:
                    raise AutomationError(429, "Too many connected editor pages.")
                identifier = secrets.token_urlsafe(24)
                self.sessions[identifier] = {"summary": metadata, "seen": time.monotonic(), "pending": None, "polling": False}
                return {"sessionId": identifier}
            if action == "sessions":
                fields(data, set())
                return {"sessions": [{"sessionId": key, **value["summary"], "busy": value["pending"] is not None}
                                     for key, value in self.sessions.items()]}
            if action not in {"poll", "result", "disconnect"}:
                raise AutomationError(404, "Unknown automation endpoint.")
            allowed = {"sessionId", "summary"} if action == "poll" else {"sessionId", "commandId", "result"} if action == "result" else {"sessionId"}
            fields(data, allowed, allowed if action != "poll" else {"sessionId", "summary"})
            session = self._session(data["sessionId"])
            session["seen"] = time.monotonic()
            if action == "disconnect":
                del self.sessions[data["sessionId"]]
                self.condition.notify_all()
                return {"disconnected": True}
            if action == "result":
                result = data["result"]
                fields(result, {"ok", "value", "error"}, {"ok"})
                if type(result["ok"]) is not bool or (not result["ok"] and not isinstance(result.get("error"), str)):
                    raise AutomationError(400, "Invalid command result.")
                pending = session["pending"]
                if pending and pending["id"] == data["commandId"] and pending["delivered"]:
                    pending["result"] = result
                    self.condition.notify_all()
                # Results may be delivered again after a lost HTTP response. They
                # are acknowledged but never cause a second execution.
                return {"received": True}
            session["summary"] = summary(data["summary"])
            if session["polling"]:
                raise AutomationError(409, "This page already has a pending poll.")
            session["polling"] = True
            try:
                deadline = time.monotonic() + self.poll_timeout
                while True:
                    self._session(data["sessionId"])
                    pending = session["pending"]
                    if pending and not pending["delivered"] and time.monotonic() < pending["deadline"]:
                        pending["delivered"] = True
                        return {"command": {key: pending[key] for key in ("id", "method", "params", "expiresAt")}}
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        return {"command": None}
                    self.condition.wait(remaining)
            finally:
                session["polling"] = False
                session["seen"] = time.monotonic()

    def command(self, data):
        fields(data, {"sessionId", "method", "params"}, {"sessionId", "method", "params"})
        if not isinstance(data["method"], str) or data["method"] not in METHODS or not isinstance(data["params"], dict):
            raise AutomationError(400, "Unknown command or invalid arguments.")
        with self.condition:
            self._prune()
            session = self._session(data["sessionId"])
            if session["pending"]:
                raise AutomationError(409, "This page is executing another command. Read state before retrying.")
            pending = {"id": secrets.token_urlsafe(24), "method": data["method"], "params": data["params"],
                       "deadline": time.monotonic() + self.command_timeout,
                       "expiresAt": int((time.time() + self.command_timeout) * 1000),
                       "delivered": False, "result": None}
            session["pending"] = pending
            self.condition.notify_all()
            try:
                while pending["result"] is None:
                    self._session(data["sessionId"])
                    remaining = pending["deadline"] - time.monotonic()
                    if remaining <= 0:
                        detail = "It was delivered; the outcome is unknown. Read state before retrying any edit." if pending["delivered"] else "It was not delivered and will not execute."
                        raise AutomationError(504, "Editor command timed out. " + detail)
                    self.condition.wait(remaining)
                result = pending["result"]
                if not result["ok"]:
                    raise AutomationError(422, result["error"])
                return result.get("value", {})
            finally:
                session["pending"] = None
                self.condition.notify_all()
