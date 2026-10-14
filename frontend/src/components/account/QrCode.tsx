import { useMemo } from "react";
import qrcode from "qrcode-generator";

const QUIET_ZONE = 4; // modules of empty border the QR specification asks for

/**
 * Renders `value` as an inline SVG (one path), computed in the browser: the value never leaves the page and no image URL
 * is needed, so the strict content security policy stays untouched. Colours are fixed black on white on purpose:
 * scanners need that contrast whatever the theme is.
 */
export default function QrCode({ value, label }: { value: string; label: string }) {
  const { size, path } = useMemo(() => {
    const code = qrcode(0, "M");
    code.addData(value);
    code.make();
    const modules = code.getModuleCount();
    let data = "";
    for (let row = 0; row < modules; row += 1) {
      for (let col = 0; col < modules; col += 1) {
        if (code.isDark(row, col)) data += `M${col + QUIET_ZONE} ${row + QUIET_ZONE}h1v1h-1z`;
      }
    }
    return { size: modules + QUIET_ZONE * 2, path: data };
  }, [value]);
  return (
    <svg className="account-qr" role="img" aria-label={label} viewBox={`0 0 ${size} ${size}`} shapeRendering="crispEdges">
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
