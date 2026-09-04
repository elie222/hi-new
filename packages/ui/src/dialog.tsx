import type { ReactNode } from "react";

export const DIALOG_CSS = `
.dialog {
  opacity: 0;
  transform: translateY(10px) scale(.97);
  transition:
    opacity .18s ease,
    transform .22s cubic-bezier(.2,.8,.2,1),
    overlay .22s allow-discrete,
    display .22s allow-discrete;
}
.dialog[open] { opacity: 1; transform: none; }
@starting-style {
  .dialog[open] { opacity: 0; transform: translateY(10px) scale(.97); }
}
.dialog::backdrop {
  opacity: 0;
  transition: opacity .2s ease, overlay .2s allow-discrete, display .2s allow-discrete;
}
.dialog[open]::backdrop { opacity: 1; }
@starting-style { .dialog[open]::backdrop { opacity: 0; } }
@media (prefers-reduced-motion: reduce) {
  .dialog, .dialog::backdrop { transition: none; }
}
`;

export function Dialog(props: {
  id: string;
  title: string;
  children: ReactNode;
  className?: string;
  cardClassName?: string;
  headingLevel?: 2 | 3;
  open?: boolean;
}) {
  const titleId = `${props.id}-title`;
  const className = ["dialog", props.className].filter(Boolean).join(" ");
  const cardClassName = ["dialog-card", props.cardClassName].filter(Boolean).join(" ");
  const title = props.headingLevel === 3
    ? <h3 id={titleId}>{props.title}</h3>
    : <h2 id={titleId}>{props.title}</h2>;

  return (
    <dialog
      className={className}
      id={props.id}
      aria-labelledby={titleId}
      data-open={props.open ? "1" : undefined}
    >
      <div className={cardClassName}>
        <div className="dialog-head">
          {title}
          <form method="dialog">
            <button className="dialog-close" type="submit" aria-label="Close">
              <span aria-hidden="true">×</span>
            </button>
          </form>
        </div>
        {props.children}
      </div>
    </dialog>
  );
}
