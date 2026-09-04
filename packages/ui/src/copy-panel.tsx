export function CopyPanel(props: { title: string; text: string; note?: string }) {
  return (
    <section className="copy-panel">
      <div className="copy-panel-head">
        <h2>{props.title}</h2>
        <button className="btn secondary" type="button" data-copy={props.text}>Copy</button>
      </div>
      <pre className="copy-panel-text">{props.text}</pre>
      {props.note ? <p className="quiet copy-panel-note">{props.note}</p> : null}
    </section>
  );
}
