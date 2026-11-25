import type { FormEventHandler } from "react";

export default function StudioComposer({ text, change, submit, canSend, onFocus, isLocked, hidden }: {
  text: string;
  change: (text: string) => void;
  submit: FormEventHandler<HTMLFormElement>;
  canSend: boolean;
  onFocus?: () => void;
  isLocked?: () => boolean;
  hidden?: boolean;
}) {
  return <form hidden={hidden} className="rs-composer" onSubmit={submit}>
    <label className="sr-only" htmlFor="studio-message">Message to Daymark assistant</label>
    <textarea id="studio-message" maxLength={8192} rows={1} value={text} onFocus={onFocus}
      onChange={event => change(event.currentTarget.value)} placeholder="Ask or describe a change…"
      onKeyDown={event => {
        if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        event.preventDefault();
        if (!event.repeat && canSend && !isLocked?.()) event.currentTarget.form?.requestSubmit();
      }} />
    <button disabled={!canSend}>Send</button>
  </form>;
}
