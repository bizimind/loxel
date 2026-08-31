import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

Element.prototype.scrollIntoView = function scrollIntoView() {};
