// Read-only PowerPoint clipboard bridge. No pasteboard mutation or file IO.
import AppKit
import CryptoKit
import Foundation

let maxBytes = 100 * 1024 * 1024
let packageType = NSPasteboard.PasteboardType("com.microsoft.PowerPoint-14.0-Slides-Package")

// Exit codes are the bounded protocol: 0 raw package, 10 no match,
// 20 clipboard changed, 21 oversized, 22 read failure, 23 ambiguous packages.
func main() throws -> Int32 {
    let request = try FileHandle.standardInput.read(upToCount: 65) ?? Data()
    guard request.isEmpty || (request.count == 64 && request.allSatisfy({
        (48...57).contains($0) || (97...102).contains($0)
    })) else { return 22 }
    let expected = request.isEmpty ? nil : String(data: request, encoding: .ascii)

    let pasteboard = NSPasteboard.general
    let revision = pasteboard.changeCount
    func stable(_ result: Int32) -> Int32 {
        return pasteboard.changeCount == revision ? result : 20
    }
    // Pair a package and optional PNG on the same item; never combine unrelated
    // representations from separate pasteboard items.
    let candidates = (pasteboard.pasteboardItems ?? []).filter {
        $0.types.contains(packageType)
    }
    guard !candidates.isEmpty else { return stable(10) }
    guard candidates.count == 1 else { return stable(23) }
    let item = candidates[0]
    if let expected = expected {
        guard item.types.contains(.png),
              let preview = item.data(forType: .png) else { return stable(10) }
        guard preview.count <= maxBytes else { return stable(21) }
        let actual = SHA256.hash(data: preview).map { String(format: "%02x", $0) }.joined()
        guard actual == expected else { return stable(10) }
    }
    guard let package = item.data(forType: packageType), !package.isEmpty else {
        return stable(22)
    }
    guard package.count <= maxBytes else { return stable(21) }
    guard pasteboard.changeCount == revision else { return 20 }
    try FileHandle.standardOutput.write(contentsOf: package)
    return 0
}

do {
    exit(try main())
} catch {
    // Do not print clipboard contents or native error details to either stream.
    exit(22)
}
