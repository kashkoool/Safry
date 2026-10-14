import { useState } from "react";
import { initials, isHexColor, readableTextOn, sameOriginLogo } from "../lib/tenant-settings";
import type { TenantSettings } from "../lib/tenant-admin";
import "./tenant-mark.css";

/** Workspace logo when it is served from this origin (the CSP blocks other image hosts), else coloured initials. */
export function TenantMark({ name, settings }: { name: string; settings?: TenantSettings }) {
  const [broken, setBroken] = useState(false);
  const logo = sameOriginLogo(settings?.branding?.logoUrl);
  const color = settings?.branding?.primaryColor;
  if (logo && !broken) {
    return <span className="tenant-mark" aria-hidden="true"><img src={logo} alt="" onError={() => setBroken(true)} /></span>;
  }
  const style = isHexColor(color) ? { background: color, color: readableTextOn(color) } : undefined;
  return <span className="tenant-mark" style={style} aria-hidden="true">{initials(name)}</span>;
}
