export function initRecentProjectMenu({ history, isBusy, open, browse }) {
  const get = id => document.getElementById(id);
  const dialog = get('recent-projects-dialog'), list = get('recent-projects-list');
  const close = () => dialog.close();
  function message(text = '', error = false) {
    get('recent-projects-status').textContent = text;
    get('recent-projects-status').classList.toggle('error', error);
  }
  function renderBusy() {
    for (const button of dialog.querySelectorAll('button')) button.disabled = isBusy();
    get('recent-projects-clear').disabled = isBusy() || !history.entries.length;
    list.setAttribute('aria-busy', String(isBusy()));
  }
  function render() {
    list.replaceChildren();
    get('recent-projects-empty').hidden = history.entries.length > 0;
    for (const entry of history.entries) {
      const row = document.createElement('li');
      const button = document.createElement('button');
      button.className = 'recent-project-open';
      button.dataset.recentId = entry.id;
      const title = document.createElement('strong');
      title.textContent = entry.projectName || entry.name;
      const file = document.createElement('span'); file.textContent = entry.name;
      const detail = document.createElement('small');
      const date = new Date(entry.lastOpened).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
      detail.textContent = `${date} · ${entry.handle ? entry.persistent ? 'Open file' : 'File access for this session' : 'Choose file again'}`;
      button.append(title, file, detail);
      button.title = `${entry.name}\n${detail.textContent}`;
      button.onclick = () => { if (!isBusy()) return open(entry); };
      const remove = document.createElement('button');
      remove.className = 'icon-button'; remove.textContent = '×';
      remove.setAttribute('aria-label', `Remove ${entry.name} from recent projects`);
      remove.title = 'Remove from history; keep the file';
      remove.onclick = async () => {
        if (isBusy()) return;
        await history.remove(entry.id); render(); message('Removed from history. The project file is kept.');
        (list.querySelector('button') || get('recent-projects-close')).focus();
      };
      row.append(button, remove); list.append(row);
    }
    renderBusy();
  }
  get('open-recent-project').onclick = () => {
    if (isBusy()) return;
    render(); message(history.storageError ? history.storageError.name === 'DataCloneError' ? 'File access lasts for this session. After reload, choose the file again.' : 'Changes to recent history cannot be saved in this browser.' : '');
    dialog.showModal();
  };
  get('recent-projects-close').onclick = close;
  get('recent-projects-browse').onclick = () => { if (!isBusy()) { close(); browse(); } };
  get('recent-projects-clear').onclick = async () => {
    if (isBusy()) return;
    await history.clear(); render(); message('History cleared. Project files and the current draft are kept.');
    get('recent-projects-close').focus();
  };
  dialog.addEventListener('cancel', event => { if (isBusy()) event.preventDefault(); });
  return { render, renderBusy, message, close };
}
