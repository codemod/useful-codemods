import type { TextAreaProps } from "../textarea/textarea";
import { TextArea as CoreTextArea } from "../textarea/textarea";

const rows: TextAreaProps = { rows: 3 };
console.log(CoreTextArea(rows));
