// Puts a window's content into a real macOS window capture, so a screenshot taken without showing
// the window still has the window's frame: rounded corners, border, traffic lights and shadow.
//
// Usage: swift composite.swift <frame.png> <content.png> <out.png> <scale>
//   frame.png    `screencapture -l` of a demo window (with its shadow), the window active
//   content.png  the window's `capturePage()`, the same size as the window in frame.png
//   scale        device pixels per point of both captures
//
// The window is the frame's fully opaque area. Inside it the content replaces the frame's pixels,
// except a thin ring along the edge (the border and the corners' anti-aliasing) and the corner
// that holds the traffic lights, which keep the frame's own pixels.
import AppKit

let args = CommandLine.arguments
guard args.count == 5, let scale = Int(args[4]) else {
  fputs("usage: swift composite.swift <frame.png> <content.png> <out.png> <scale>\n", stderr)
  exit(2)
}

/// RGBA8 pixels of an image, converted to sRGB so both inputs share one color space.
func pixels(_ path: String) -> (data: [UInt8], width: Int, height: Int) {
  guard let image = NSImage(contentsOfFile: path) else {
    fputs("can't read \(path)\n", stderr)
    exit(1)
  }
  var rect = CGRect.zero
  guard let cg = image.cgImage(forProposedRect: &rect, context: nil, hints: nil) else { exit(1) }
  let (w, h) = (cg.width, cg.height)
  var data = [UInt8](repeating: 0, count: w * h * 4)
  data.withUnsafeMutableBytes { buffer in
    let context = CGContext(
      data: buffer.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
      space: CGColorSpace(name: CGColorSpace.sRGB)!,
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    context.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
  }
  return (data, w, h)
}

var frame = pixels(args[1])
let content = pixels(args[2])
let alpha = { (x: Int, y: Int) in frame.data[(y * frame.width + x) * 4 + 3] }

// The window: the bounding box of the frame's fully opaque pixels.
var (minX, minY, maxX, maxY) = (frame.width, frame.height, -1, -1)
for y in 0..<frame.height {
  for x in 0..<frame.width where alpha(x, y) == 255 {
    minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y)
  }
}
let (winW, winH) = (maxX - minX + 1, maxY - minY + 1)
guard winW == content.width, winH == content.height else {
  fputs("window is \(winW)x\(winH) in the frame but the content is \(content.width)x\(content.height)\n", stderr)
  exit(1)
}

// Corner radius: how far along the window's top row the first opaque pixel is.
var radius = 0
while radius < winW / 2 && alpha(minX + radius, minY) != 255 { radius += 1 }
radius = max(radius, 1)

let ring = 2  // pixels of the frame kept along the edge: the border and the corner anti-aliasing
let lights = (width: 80 * scale, height: 30 * scale)  // the traffic lights' corner, kept from the frame

/// Whether a window pixel lies inside the rounded rectangle inset by `ring`.
func insideInset(_ x: Int, _ y: Int) -> Bool {
  let r = Double(max(radius - ring, 0))
  let (lo, hiX, hiY) = (Double(ring), Double(winW - 1 - ring), Double(winH - 1 - ring))
  let (px, py) = (Double(x), Double(y))
  guard px >= lo, px <= hiX, py >= lo, py <= hiY else { return false }
  let cx = px < lo + r ? lo + r : (px > hiX - r ? hiX - r : px)
  let cy = py < lo + r ? lo + r : (py > hiY - r ? hiY - r : py)
  return (px - cx) * (px - cx) + (py - cy) * (py - cy) <= r * r
}

for y in 0..<winH {
  for x in 0..<winW where insideInset(x, y) && !(x < lights.width && y < lights.height) {
    let dst = ((minY + y) * frame.width + (minX + x)) * 4
    let src = (y * content.width + x) * 4
    for c in 0..<4 { frame.data[dst + c] = content.data[src + c] }
  }
}

let space = CGColorSpace(name: CGColorSpace.sRGB)!
let (frameW, frameH) = (frame.width, frame.height)
let out = frame.data.withUnsafeMutableBytes { buffer in
  CGContext(
    data: buffer.baseAddress, width: frameW, height: frameH, bitsPerComponent: 8,
    bytesPerRow: frameW * 4, space: space,
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!.makeImage()!
}
let rep = NSBitmapImageRep(cgImage: out)
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: args[3]))
print("composited \(args[2]) into the window at \(minX),\(minY) (\(winW)x\(winH), radius \(radius)px)")
