/** Minimal host API for exercising the real plugin in the browser harness. */
import en from "../i18n/en_US.json";
export const editors: any[] = [];
export const messages: string[] = [];
export const getAllEditor = () => editors;
export const getFrontend = () => "browser-desktop";
export const showMessage = (message: string) => { messages.push(message); };
export const confirm = (_title: string, _message: string, callback: () => void) => callback();
export const fetchSyncPost = async (url: string, data: unknown) => (await fetch(url, {
    method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(data),
})).json();
export class Setting {
    items: any[] = [];
    constructor(_options: unknown) {}
    addItem(item: any) { this.items.push(item); }
}
export class Plugin {
    name = "pencil-annotation";
    i18n = en;
    setting: any;
    eventBus = {on: (_name: string, _cb: unknown) => {}};
    data: Record<string, unknown> = {};
    loadData = async (name: string) => this.data[name];
    saveData = async (name: string, value: unknown) => { this.data[name] = value; return {code: 0}; };
    addTopBar(_options: unknown) {}
    addCommand(_options: unknown) {}
    openSetting() {}
}
export class Dialog {
    element = document.createElement("div");
    constructor(options: {content: string}) { this.element.innerHTML = options.content; }
    destroy() { this.element.remove(); }
}
