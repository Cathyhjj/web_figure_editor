// Render the existing Figure Editor three-panel brand mark as a macOS icon.
import AppKit

let output = CommandLine.arguments[1]
let size = 1024
let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
                             bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                             isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)

func color(_ red: CGFloat, _ green: CGFloat, _ blue: CGFloat) -> NSColor {
    return NSColor(srgbRed: red / 255, green: green / 255, blue: blue / 255, alpha: 1)
}
func panel(_ rect: NSRect, _ radius: CGFloat, _ fill: NSColor) {
    fill.setFill()
    NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius).fill()
}

let tile = NSBezierPath(roundedRect: NSRect(x: 64, y: 64, width: 896, height: 896), xRadius: 200, yRadius: 200)
NSGraphicsContext.saveGraphicsState()
let shadow = NSShadow()
shadow.shadowColor = NSColor.black.withAlphaComponent(0.16)
shadow.shadowBlurRadius = 28
shadow.shadowOffset = NSSize(width: 0, height: -12)
shadow.set()
color(249, 247, 251).setFill()
tile.fill()
NSGraphicsContext.restoreGraphicsState()
NSGradient(starting: .white, ending: color(241, 235, 245))!.draw(in: tile, angle: -90)

// Same arrangement and palette as style.css .brand-mark.
let left = NSBezierPath(roundedRect: NSRect(x: 238, y: 230, width: 224, height: 576), xRadius: 48, yRadius: 48)
NSGradient(starting: color(59, 15, 112), ending: color(140, 41, 129))!.draw(in: left, angle: -45)
panel(NSRect(x: 526, y: 566, width: 272, height: 240), 48, color(183, 55, 121))
panel(NSRect(x: 526, y: 230, width: 272, height: 272), 48, color(237, 130, 109))
NSGraphicsContext.restoreGraphicsState()
try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: output))
