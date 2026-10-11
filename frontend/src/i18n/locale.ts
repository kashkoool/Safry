export function currentLocale(): "ar-SA" | "en-US" {
  try { return localStorage.getItem("safry.language") === "en" ? "en-US" : "ar-SA"; }
  catch { return "ar-SA"; }
}
