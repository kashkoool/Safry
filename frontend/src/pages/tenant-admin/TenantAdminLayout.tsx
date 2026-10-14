import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, ShieldCheck } from "lucide-react";
import { Brand } from "../../components/Brand";
import { LanguageSwitch } from "../../i18n/LanguageSwitch";
import { useLanguage } from "../../i18n/useLanguage";
import "../tenant-admin.css";

/** Shared frame of the workspace administration pages (roles, audit, settings). */
export function TenantAdminLayout({ title, intro, tabs, children }: {
  title: string;
  intro: string;
  tabs?: Array<{ to: string; label: string; active: boolean }>;
  children: ReactNode;
}) {
  const { pick } = useLanguage();
  return (
    <main className="ta-page">
      <header className="ta-header">
        <Brand compact />
        <div className="ta-header-copy">
          <span className="eyebrow eyebrow--dark"><ShieldCheck size={16} aria-hidden="true" /> {pick("إدارة مساحة العمل", "Workspace administration")}</span>
          <h1>{title}</h1>
          <p>{intro}</p>
        </div>
        <div className="ta-header-actions">
          <LanguageSwitch />
          <Link className="ghost-button" to="/workspace/overview"><ArrowLeft size={17} aria-hidden="true" />{pick("العودة إلى مساحة العمل", "Back to workspace")}</Link>
        </div>
      </header>
      {tabs && tabs.length > 1 && (
        <nav className="ta-tabs" aria-label={pick("أقسام الإدارة", "Administration sections")}>
          {tabs.map((tab) => <Link key={tab.to} to={tab.to} aria-current={tab.active ? "page" : undefined}>{tab.label}</Link>)}
        </nav>
      )}
      {children}
    </main>
  );
}
