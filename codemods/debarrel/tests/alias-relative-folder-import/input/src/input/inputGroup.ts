import type { TextAreaProps } from "../textarea";
import { TextArea as CoreTextArea } from "../textarea";

const rows: TextAreaProps = { rows: 3 };
console.log(CoreTextArea(rows));
