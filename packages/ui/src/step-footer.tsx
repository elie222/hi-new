import type { ReactNode } from "react";

export function StepFooter(props: { onBack: () => void; backLabel?: string; action?: ReactNode }) {
  return (
    <div className="panel-foot">
      <button className="btn btn-secondary" type="button" onClick={props.onBack}>{props.backLabel ?? "Back"}</button>
      {props.action ?? <span />}
    </div>
  );
}
