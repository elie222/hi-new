import type { ReactNode } from "react";

export function Headline({ title, sub }: { title: ReactNode; sub?: ReactNode }) {
  return (
    <>
      <h1 id="headline">{title}</h1>
      {sub && <p id="subline" className="iz-lead">{sub}</p>}
    </>
  );
}
