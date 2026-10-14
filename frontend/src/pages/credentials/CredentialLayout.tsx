import { type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, LockKeyhole } from "lucide-react";
import { Brand } from "../../components/Brand";
import { LanguageSwitch } from "../../i18n/LanguageSwitch";
import { useLanguage } from "../../i18n/useLanguage";
import { getLoginPortal } from "../../lib/api";
import { AuthStory } from "../LoginPage";
import "../auth-premium.css";
import "./credentials.css";

/** Shell shared by the public credential pages. It loads nothing from other origins, so a token page leaks nothing. */
export function CredentialLayout({ eyebrow, title, intro, children }: { eyebrow: string; title: string; intro?: string; children: ReactNode }) {
  const { pick } = useLanguage();
  return <main className="premium-auth premium-auth--register">
    <AuthStory portal="customer" />
    <section className="auth-panel">
      <div className="auth-panel__top"><div className="auth-mobile-brand"><Brand compact /></div><LanguageSwitch /></div>
      <div className="auth-card credential-card">
        <Link className="auth-back" to={`/login/${getLoginPortal() ?? "customer"}`}><ArrowLeft size={16} className="auth-directional" />{pick("العودة إلى تسجيل الدخول", "Back to sign in")}</Link>
        <header className="auth-heading"><span className="auth-eyebrow">{eyebrow}</span><h2>{title}</h2>{intro && <p>{intro}</p>}</header>
        {children}
      </div>
      <footer className="auth-panel__footer"><LockKeyhole size={14} />{pick("مساحتك الخاصة لإدارة السفر", "Your personal travel workspace")}</footer>
    </section>
  </main>;
}
