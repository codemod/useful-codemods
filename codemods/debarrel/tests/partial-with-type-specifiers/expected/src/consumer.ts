import { VERSION } from "./lib";
import { Config } from "./lib/config";
import { helper } from "./lib/helper";

const x: Config = { debug: true };
console.log(helper(), VERSION);
