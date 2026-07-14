// Command genicon renders the Query Schema app icon and writes it as a
// multi-resolution Windows .ico (PNG-encoded entries, Vista+).
//
// The mark matches the in-app brand: the database cylinder (the same glyph the
// web UI shows in its header/download page) knocked out of a rounded square
// filled with the brand green gradient.
//
// Regenerate with:
//
//	go run ./tools/genicon -o icon.ico
//
// then re-embed it into the exe (see build.ps1 / rsrc).
package main

import (
	"bytes"
	"encoding/binary"
	"flag"
	"image"
	"image/color"
	"image/png"
	"log"
	"math"
	"os"
)

// Brand palette. The gradient matches the agent window's logo tile
// (internal/ui/ui.go) and the web app's primary green.
var (
	gradTop = color.NRGBA{0x34, 0xD3, 0x99, 0xFF} // #34d399
	gradBot = color.NRGBA{0x05, 0x96, 0x69, 0xFF} // #059669
	markCol = color.NRGBA{0x04, 0x12, 0x0C, 0xFF} // near-black green, as in the UI tile
)

// ssaa is the supersampling factor: every icon is rendered at size*ssaa and
// box-filtered down, which is what keeps the 16px and 32px entries legible.
const ssaa = 4

// sizes are the entries packed into the .ico. Windows picks per context
// (16 = title bar, 32 = taskbar/alt-tab, 256 = large icons view).
var sizes = []int{256, 128, 64, 48, 32, 16}

func main() {
	out := flag.String("o", "icon.ico", "output .ico path")
	flag.Parse()

	var imgs []*image.NRGBA
	for _, s := range sizes {
		imgs = append(imgs, render(s))
	}
	data, err := encodeICO(imgs)
	if err != nil {
		log.Fatalf("encode ico: %v", err)
	}
	if err := os.WriteFile(*out, data, 0o644); err != nil {
		log.Fatalf("write %s: %v", *out, err)
	}
	log.Printf("wrote %s (%d entries, %d bytes)", *out, len(imgs), len(data))
}

// render draws one square icon at the given pixel size.
func render(size int) *image.NRGBA {
	hi := size * ssaa
	big := image.NewNRGBA(image.Rect(0, 0, hi, hi))

	f := float64(hi)
	radius := f * 0.22 // rounded-square corner radius (matches the UI tile)

	for y := 0; y < hi; y++ {
		for x := 0; x < hi; x++ {
			px, py := float64(x)+0.5, float64(y)+0.5

			// Outside the rounded square -> fully transparent.
			if !insideRoundRect(px, py, f, f, radius) {
				continue
			}

			// Background: diagonal brand gradient.
			t := clamp01((px + py) / (2 * f))
			c := lerpColor(gradTop, gradBot, t)

			// Foreground: the database cylinder, knocked out in near-black.
			if inMark(px/f, py/f) {
				c = markCol
			}
			big.SetNRGBA(x, y, c)
		}
	}
	return downsample(big, size)
}

// inMark reports whether the normalized point (0..1 in both axes) is part of the
// database-cylinder glyph: a top ellipse, a body, a bottom cap, and two "band"
// arcs cut back out to suggest stacked platters.
func inMark(x, y float64) bool {
	const (
		cx    = 0.50  // cylinder centre
		rx    = 0.255 // half-width
		ry    = 0.085 // ellipse (perspective) half-height
		yTop  = 0.315 // centre of the top ellipse
		yBot  = 0.685 // centre of the bottom cap
		bandT = 0.030 // thickness of a knocked-out band
	)

	// Silhouette = top ellipse ∪ body rectangle ∪ bottom ellipse.
	inTop := ellipse(x, y, cx, yTop, rx, ry) <= 1
	inBody := x >= cx-rx && x <= cx+rx && y >= yTop && y <= yBot
	inBot := ellipse(x, y, cx, yBot, rx, ry) <= 1
	if !inTop && !inBody && !inBot {
		return false
	}

	// Knock out the two front-facing band arcs. Each is the lower half of an
	// ellipse outline (y >= its centre), so it reads as the front edge of a
	// platter rather than a full ring.
	for _, bc := range []float64{0.4483, 0.5666} {
		if y >= bc && math.Abs(math.Sqrt(ellipse(x, y, cx, bc, rx, ry))-1) < bandT/ry/2 {
			return false
		}
	}
	return true
}

// ellipse returns the normalized radial term: <=1 means inside.
func ellipse(x, y, cx, cy, rx, ry float64) float64 {
	dx := (x - cx) / rx
	dy := (y - cy) / ry
	return dx*dx + dy*dy
}

// insideRoundRect reports whether (px,py) is inside a w×h rounded rectangle
// anchored at the origin with the given corner radius.
func insideRoundRect(px, py, w, h, r float64) bool {
	// Clamp the point to the inner rect whose corners are the circle centres;
	// the distance to that clamped point is the distance to the shape.
	qx := math.Max(r, math.Min(px, w-r))
	qy := math.Max(r, math.Min(py, h-r))
	dx, dy := px-qx, py-qy
	return dx*dx+dy*dy <= r*r
}

// downsample box-filters the supersampled image down to size×size, averaging in
// premultiplied space so transparent edge pixels don't bleed dark halos.
func downsample(src *image.NRGBA, size int) *image.NRGBA {
	dst := image.NewNRGBA(image.Rect(0, 0, size, size))
	n := float64(ssaa * ssaa)
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			var pr, pg, pb, pa float64
			for sy := 0; sy < ssaa; sy++ {
				for sx := 0; sx < ssaa; sx++ {
					c := src.NRGBAAt(x*ssaa+sx, y*ssaa+sy)
					a := float64(c.A) / 255
					pr += float64(c.R) * a
					pg += float64(c.G) * a
					pb += float64(c.B) * a
					pa += a
				}
			}
			if pa == 0 {
				continue // fully transparent
			}
			// Un-premultiply back to straight alpha.
			dst.SetNRGBA(x, y, color.NRGBA{
				R: uint8(math.Round(pr / pa)),
				G: uint8(math.Round(pg / pa)),
				B: uint8(math.Round(pb / pa)),
				A: uint8(math.Round(pa / n * 255)),
			})
		}
	}
	return dst
}

func clamp01(v float64) float64 { return math.Max(0, math.Min(1, v)) }

func lerpColor(a, b color.NRGBA, t float64) color.NRGBA {
	return color.NRGBA{
		R: uint8(math.Round(float64(a.R) + (float64(b.R)-float64(a.R))*t)),
		G: uint8(math.Round(float64(a.G) + (float64(b.G)-float64(a.G))*t)),
		B: uint8(math.Round(float64(a.B) + (float64(b.B)-float64(a.B))*t)),
		A: 0xFF,
	}
}

// encodeICO packs the images into the ICO container as PNG entries, which
// Windows has supported since Vista and which keeps the file small.
func encodeICO(imgs []*image.NRGBA) ([]byte, error) {
	type entry struct {
		w, h int
		png  []byte
	}
	var entries []entry
	for _, im := range imgs {
		var buf bytes.Buffer
		if err := png.Encode(&buf, im); err != nil {
			return nil, err
		}
		b := im.Bounds()
		entries = append(entries, entry{w: b.Dx(), h: b.Dy(), png: buf.Bytes()})
	}

	var out bytes.Buffer
	// ICONDIR: reserved=0, type=1 (icon), count.
	binary.Write(&out, binary.LittleEndian, uint16(0))
	binary.Write(&out, binary.LittleEndian, uint16(1))
	binary.Write(&out, binary.LittleEndian, uint16(len(entries)))

	// Image data begins after the directory (6) + 16 bytes per entry.
	offset := 6 + 16*len(entries)
	for _, e := range entries {
		// A 256px side is encoded as 0.
		dim := func(v int) byte {
			if v >= 256 {
				return 0
			}
			return byte(v)
		}
		out.WriteByte(dim(e.w))
		out.WriteByte(dim(e.h))
		out.WriteByte(0) // palette colours (0 = truecolour)
		out.WriteByte(0) // reserved
		binary.Write(&out, binary.LittleEndian, uint16(1))  // colour planes
		binary.Write(&out, binary.LittleEndian, uint16(32)) // bits per pixel
		binary.Write(&out, binary.LittleEndian, uint32(len(e.png)))
		binary.Write(&out, binary.LittleEndian, uint32(offset))
		offset += len(e.png)
	}
	for _, e := range entries {
		out.Write(e.png)
	}
	return out.Bytes(), nil
}
