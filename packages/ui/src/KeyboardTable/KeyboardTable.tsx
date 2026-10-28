import { KeyHint } from '../KeyHint/KeyHint.tsx';
import './KeyboardTable.css';

export type KeyboardTableProps = {
  caption: string;
  /** `alt`: a second chord for the same action (the merge of tasks 9 and 10: Control+/ opens the same palette as Control/⌘+K). */
  rows: readonly { action: string; keys: string[]; alt?: string[] }[];
  /** The word between a row's two chords ("or"); needed when a row has `alt`. */
  orLabel?: string;
};

/** The keyboard shortcuts of Settings (I3): a two-column table, the action on the left and its chord (KeyHint) on the right. */
export function KeyboardTable({ caption, rows, orLabel }: KeyboardTableProps) {
  return (
    <table className="d-keyboard-table">
      <caption className="d-keyboard-table__caption">{caption}</caption>
      <tbody>
        {rows.map(row => (
          <tr key={row.action} className="d-keyboard-table__row" data-row>
            <th scope="row" className="d-keyboard-table__action">{row.action}</th>
            <td className="d-keyboard-table__keys"><KeyHint keys={row.keys} />
              {row.alt !== undefined ? <><span className="d-keyboard-table__or">{orLabel}</span><KeyHint keys={row.alt} /></> : null}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
