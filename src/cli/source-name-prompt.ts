import {
  createPrompt,
  isEnterKey,
  useKeypress,
  useState,
} from "@inquirer/core";
import { withInputClosedGuard } from "./prompts.js";

const prompt = createPrompt<string, Record<string, never>>((_config, done) => {
  const [value, setValue] = useState("");
  const [finished, setFinished] = useState(false);
  useKeypress((key, rl) => {
    if (isEnterKey(key)) {
      if (!value.trim()) return;
      setFinished(true);
      done(value.trim());
    } else {
      setValue(rl.line);
    }
  });
  return [
    `Which source are you looking for?\n\nName or website: ${value}`,
    finished
      ? ""
      : "--------------------------------------------------\nEnter: continue | Ctrl+C: exit",
  ];
});

/** Ask for the missing source, retaining the approved footer below the input. */
export function sourceNamePrompt(): Promise<string> {
  return withInputClosedGuard((context) => prompt({}, context));
}
