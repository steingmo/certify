// Renders the Certify app icon as a 1024x1024 PNG.
// Run: swift assets/make-icon.swift <output.png>
import AppKit

let size: CGFloat = 1024
let outputPath = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "icon_1024.png"

let image = NSImage(size: NSSize(width: size, height: size))
image.lockFocus()

// Background squircle — macOS icon grid: 824pt tile on a 1024 canvas.
let tile = NSRect(x: 100, y: 100, width: 824, height: 824)
let squircle = NSBezierPath(roundedRect: tile, xRadius: 185, yRadius: 185)
NSGradient(
    starting: NSColor(red: 0.13, green: 0.17, blue: 0.28, alpha: 1),
    ending: NSColor(red: 0.06, green: 0.08, blue: 0.15, alpha: 1)
)!.draw(in: squircle, angle: -90)

squircle.setClip()
NSColor.white.withAlphaComponent(0.07).setStroke()
let edge = NSBezierPath(roundedRect: tile.insetBy(dx: 3, dy: 3), xRadius: 182, yRadius: 182)
edge.lineWidth = 6
edge.stroke()

// Certificate document.
let doc = NSRect(x: 302, y: 250, width: 420, height: 540)
let docPath = NSBezierPath(roundedRect: doc, xRadius: 36, yRadius: 36)
NSGradient(
    starting: NSColor(red: 0.98, green: 0.97, blue: 0.94, alpha: 1),
    ending: NSColor(red: 0.88, green: 0.87, blue: 0.83, alpha: 1)
)!.draw(in: docPath, angle: -90)

// Text lines on the certificate.
NSColor(red: 0.55, green: 0.55, blue: 0.58, alpha: 1).setFill()
let lineWidths: [CGFloat] = [300, 300, 220]
for (index, width) in lineWidths.enumerated() {
    let y = doc.maxY - 120 - CGFloat(index) * 78
    NSBezierPath(
        roundedRect: NSRect(x: doc.minX + 60, y: y, width: width, height: 30),
        xRadius: 15, yRadius: 15
    ).fill()
}

// Seal: green badge with checkmark, overlapping the document's bottom edge.
let sealCenter = NSPoint(x: doc.maxX - 90, y: doc.minY + 20)
let sealRadius: CGFloat = 130

// Scalloped seal edge.
let scallops = 12
let seal = NSBezierPath()
for i in 0..<(scallops * 2) {
    let angle = CGFloat(i) * .pi / CGFloat(scallops)
    let r = i.isMultiple(of: 2) ? sealRadius : sealRadius * 0.88
    let point = NSPoint(x: sealCenter.x + r * cos(angle), y: sealCenter.y + r * sin(angle))
    if i == 0 { seal.move(to: point) } else { seal.line(to: point) }
}
seal.close()
NSColor(red: 0.10, green: 0.55, blue: 0.30, alpha: 1).setFill()
seal.fill()

NSBezierPath(ovalIn: NSRect(
    x: sealCenter.x - sealRadius * 0.72, y: sealCenter.y - sealRadius * 0.72,
    width: sealRadius * 1.44, height: sealRadius * 1.44
)).addClip()
NSGradient(
    starting: NSColor(red: 0.22, green: 0.75, blue: 0.45, alpha: 1),
    ending: NSColor(red: 0.12, green: 0.60, blue: 0.34, alpha: 1)
)!.draw(in: NSRect(
    x: sealCenter.x - sealRadius, y: sealCenter.y - sealRadius,
    width: sealRadius * 2, height: sealRadius * 2
), angle: -90)

// Checkmark.
let check = NSBezierPath()
check.lineWidth = 26
check.lineCapStyle = .round
check.lineJoinStyle = .round
check.move(to: NSPoint(x: sealCenter.x - 52, y: sealCenter.y + 2))
check.line(to: NSPoint(x: sealCenter.x - 12, y: sealCenter.y - 38))
check.line(to: NSPoint(x: sealCenter.x + 56, y: sealCenter.y + 40))
NSColor.white.setStroke()
check.stroke()

image.unlockFocus()

guard let tiff = image.tiffRepresentation,
      let rep = NSBitmapImageRep(data: tiff),
      let png = rep.representation(using: .png, properties: [:]) else {
    fputs("Failed to render icon\n", stderr)
    exit(1)
}
try! png.write(to: URL(fileURLWithPath: outputPath))
print("Wrote \(outputPath)")
