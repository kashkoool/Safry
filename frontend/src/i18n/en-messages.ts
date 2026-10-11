import base from "./base-messages.json";
import extra from "./messages.json";

const messages: Record<string, string> = { ...base, ...extra };
export default messages;
