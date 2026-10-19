// Trusted native font helper. Reads one validated JSON request on stdin only.
import Foundation
import CoreText
import CoreGraphics

struct Item: Decodable {
    let id: String
    let text: String
    let fontFamily: String
    let fontSize: Double
    let fontWeight: String
    let fontStyle: String
}
struct Request: Decodable { let items: [Item] }
struct Line: Encodable { let width: Double; let path: String }
struct Outline: Encodable { let id: String; let lines: [Line] }
struct Substitution: Encodable { let id: String; let requested: String; let actual: String }
struct Response: Encodable { let outlines: [Outline]; let substitutions: [Substitution] }
struct Failure: Error { let message: String }

let maxOutputBytes = 64 * 1024 * 1024
let availableFamilies = CTFontManagerCopyAvailableFontFamilyNames() as! [String]
let familyLookup = Dictionary(availableFamilies.map { ($0.lowercased(), $0) }, uniquingKeysWith: { first, _ in first })

func number(_ value: CGFloat) -> String {
    // PDF numbers do not permit scientific notation, even for tiny control points.
    var result = String(format: "%.6f", locale: Locale(identifier: "en_US_POSIX"), Double(value))
    while result.last == "0" { result.removeLast() }
    if result.last == "." { result.removeLast() }
    return result == "-0" || result.isEmpty ? "0" : result
}

func fontFor(_ item: Item) -> (CTFont, Substitution?) {
    let primary = item.fontFamily.split(separator: ",", omittingEmptySubsequences: false).first.map(String.init) ?? "Arial"
    let requested = primary.trimmingCharacters(in: CharacterSet.whitespaces.union(CharacterSet(charactersIn: "\"'")))
    let generic = ["sans-serif": "Arial", "serif": "Times New Roman", "monospace": "Courier New", "system-ui": "Helvetica"]
    let desired = generic[requested.lowercased()] ?? requested
    let family = familyLookup[desired.lowercased()] ?? "Arial"
    let weights: [String: Double] = ["100": -0.8, "200": -0.6, "300": -0.4, "400": 0, "500": 0.23, "600": 0.3, "700": 0.4, "800": 0.56, "900": 0.62, "normal": 0, "bold": 0.4]
    let traits: [CFString: Any] = [kCTFontWeightTrait: weights[item.fontWeight] ?? 0,
                                  kCTFontSymbolicTrait: item.fontStyle == "normal" ? 0 : CTFontSymbolicTraits.traitItalic.rawValue]
    let attributes: [CFString: Any] = [kCTFontFamilyNameAttribute: family, kCTFontTraitsAttribute: traits]
    let descriptor = CTFontDescriptorCreateWithAttributes(attributes as CFDictionary)
    let font = CTFontCreateWithFontDescriptor(descriptor, CGFloat(item.fontSize), nil)
    let substitution = familyLookup[desired.lowercased()] == nil ? Substitution(id: item.id, requested: requested, actual: family) : nil
    return (font, substitution)
}

func pathCommands(_ path: CGPath) -> String {
    var parts: [String] = []
    var current = CGPoint.zero
    var beginning = CGPoint.zero
    func point(_ point: CGPoint) -> String { "\(number(point.x)) \(number(point.y))" }
    path.applyWithBlock { pointer in
        let element = pointer.pointee
        switch element.type {
        case .moveToPoint:
            current = element.points[0]; beginning = current
            parts.append("\(point(current)) m")
        case .addLineToPoint:
            current = element.points[0]
            parts.append("\(point(current)) l")
        case .addQuadCurveToPoint:
            let control = element.points[0], end = element.points[1]
            let first = CGPoint(x: current.x + (control.x - current.x) * 2 / 3, y: current.y + (control.y - current.y) * 2 / 3)
            let second = CGPoint(x: end.x + (control.x - end.x) * 2 / 3, y: end.y + (control.y - end.y) * 2 / 3)
            parts.append("\(point(first)) \(point(second)) \(point(end)) c")
            current = end
        case .addCurveToPoint:
            parts.append("\(point(element.points[0])) \(point(element.points[1])) \(point(element.points[2])) c")
            current = element.points[2]
        case .closeSubpath:
            parts.append("h"); current = beginning
        @unknown default: break
        }
    }
    return parts.joined(separator: "\n")
}

func invisible(_ scalar: Unicode.Scalar) -> Bool {
    if CharacterSet.whitespacesAndNewlines.contains(scalar) { return true }
    switch scalar.properties.generalCategory {
    case .format, .control: return true
    default: return scalar.value == 0xFE0F || scalar.value == 0xFE0E
    }
}

func outlineLine(_ text: String, font: CTFont, identifier: String) throws -> Line {
    if text.isEmpty { return Line(width: 0, path: "") }
    let attributed = NSAttributedString(string: text, attributes: [NSAttributedString.Key(kCTFontAttributeName as String): font])
    let line = CTLineCreateWithAttributedString(attributed)
    let runs = CTLineGetGlyphRuns(line) as! [CTRun]
    var paths: [String] = []
    var pathBytes = 0
    let utf16 = Array(text.utf16)
    for run in runs {
        let count = CTRunGetGlyphCount(run)
        if count == 0 { continue }
        let attributes = CTRunGetAttributes(run) as NSDictionary
        guard let rawFont = attributes[kCTFontAttributeName] else { throw Failure(message: "A PDF text run has no font.") }
        let runFont = rawFont as! CTFont
        var glyphs = [CGGlyph](repeating: 0, count: count)
        var positions = [CGPoint](repeating: .zero, count: count)
        var indices = [CFIndex](repeating: 0, count: count)
        CTRunGetGlyphs(run, CFRange(location: 0, length: 0), &glyphs)
        CTRunGetPositions(run, CFRange(location: 0, length: 0), &positions)
        CTRunGetStringIndices(run, CFRange(location: 0, length: 0), &indices)
        let runRange = CTRunGetStringRange(run)
        let boundaries = Array(Set(indices + [runRange.location + runRange.length])).sorted()
        for index in 0..<count {
            var transform = CGAffineTransform(translationX: positions[index].x, y: positions[index].y)
            if glyphs[index] != 0, let path = CTFontCreatePathForGlyph(runFont, glyphs[index], &transform), !path.isEmpty {
                let commands = pathCommands(path)
                pathBytes += commands.utf8.count
                if pathBytes > maxOutputBytes { throw Failure(message: "The outlined PDF text is too complex. Split this slide into smaller slides.") }
                paths.append(commands)
            } else {
                let start = max(0, min(indices[index], utf16.count))
                let end = max(start, min(boundaries.first(where: { $0 > start }) ?? start + 1, utf16.count))
                let cluster = String(decoding: utf16[start..<end], as: UTF16.self)
                if cluster.unicodeScalars.contains(where: { !invisible($0) }) {
                    throw Failure(message: "PDF text \"\(identifier)\" contains a character without a vector outline (for example, a color emoji). Replace that character or export PNG instead.")
                }
            }
        }
    }
    return Line(width: max(0, CTLineGetTypographicBounds(line, nil, nil, nil)), path: paths.joined(separator: "\n"))
}

do {
    let input = FileHandle.standardInput.readDataToEndOfFile()
    guard input.count <= 2 * 1024 * 1024 else { throw Failure(message: "The PDF text request is too large.") }
    let request = try JSONDecoder().decode(Request.self, from: input)
    guard request.items.count <= 2000, request.items.reduce(0, { $0 + $1.text.unicodeScalars.count }) <= 100000 else {
        throw Failure(message: "The PDF text request exceeds the supported slide size.")
    }
    var outlines: [Outline] = [], substitutions: [Substitution] = []
    var totalPathBytes = 0
    for item in request.items {
        guard item.fontSize.isFinite, item.fontSize >= 1, item.fontSize <= 2000 else { throw Failure(message: "The PDF font size is invalid.") }
        let (font, substitution) = fontFor(item)
        if let substitution = substitution { substitutions.append(substitution) }
        var lines: [Line] = []
        for text in item.text.components(separatedBy: "\n") {
            let line = try outlineLine(text, font: font, identifier: item.id)
            totalPathBytes += line.path.utf8.count
            guard totalPathBytes < maxOutputBytes - 1024 * 1024 else { throw Failure(message: "The outlined PDF text is too complex. Split this slide into smaller slides.") }
            lines.append(line)
        }
        outlines.append(Outline(id: item.id, lines: lines))
    }
    let output = try JSONEncoder().encode(Response(outlines: outlines, substitutions: substitutions))
    guard output.count <= maxOutputBytes else { throw Failure(message: "The outlined PDF text is too complex. Split this slide into smaller slides.") }
    FileHandle.standardOutput.write(output)
} catch {
    let message = (error as? Failure)?.message ?? "The PDF text request could not be processed."
    let output = try! JSONSerialization.data(withJSONObject: ["error": message])
    FileHandle.standardOutput.write(output)
    exit(1)
}
