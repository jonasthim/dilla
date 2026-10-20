import { KeyHint } from '../KeyHint/KeyHint.tsx';
import './KeyboardTable.css';

export type KeyboardTableProps = { caption: string; rows: readonly { action: string; keys: string[] }[] };

/** The keyboard shortcuts of Settings (I3): a two-column table, the action on the left and its chord (KeyHint) on the right. */
export function KeyboardTable({ caption, rows }: KeyboardTableProps) {
  return (
    <table className="d-keyboard-table">
      <caption className="d-keyboard-table__caption">{caption}</caption>
      <tbody>
        {rows.map(row => (
          <tr key={row.action} className="d-keyboard-table__row" data-row>
            <th scope="row" className="d-keyboard-table__action">{row.action}</th>
            <td className="d-keyboard-table__keys"><KeyHint keys={row.keys} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
