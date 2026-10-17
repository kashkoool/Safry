import { Link } from "react-router-dom";
import { Brand } from "../components/Brand";
import { useLanguage } from "../i18n/useLanguage";

/** Any address the app does not know. It links home instead of silently redirecting, so a wrong link is visible. */
export function NotFoundPage() {
  const { pick } = useLanguage();
  return (
    <main className="status-screen">
      <Brand />
      <h1>{pick("الصفحة غير موجودة", "Page not found")}</h1>
      <p>{pick("الرابط الذي فتحته غير صحيح أو لم يعد متاحاً.", "The link you opened is not correct or is no longer available.")}</p>
      <Link className="status-screen__action" to="/">{pick("العودة إلى الصفحة الرئيسية", "Go to the home page")}</Link>
    </main>
  );
}
