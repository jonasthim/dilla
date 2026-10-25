import { useId, useState } from 'react';
import { SettingsNav } from '@dilla/ui';
import { t } from '../strings/index.ts';
import { availableSettings, searchSettings, type SettingsAccess, type SettingsEntry, type SettingsScope } from './registry.ts';
import './workspace.css';

export interface SettingsNavigationProps {
  scope: SettingsScope;
  access?: SettingsAccess;
  activeId: string;
  onSelect: (id: SettingsEntry['id'], anchor?: string | null) => void;
}
/** Search reads only this registry. It never loads a section or any account values. */
export function SettingsNavigation({ scope, access, activeId, onSelect }: SettingsNavigationProps) {
  const [query, setQuery] = useState('');
  const id = useId();
  const sections = availableSettings(scope, access);
  const results = searchSettings(scope, query, access);
  const activate = (sectionId: SettingsEntry['id'], anchor: string | null = null) => {
    if (!availableSettings(scope, access).some(entry => entry.id === sectionId)) return;
    onSelect(sectionId, anchor);
    setQuery('');
  };
  return <>
    <div className="dw-settings-search">
      <label htmlFor={id}>{t('workspace.search')}</label>
      <input id={id} type="search" value={query} autoComplete="off" spellCheck={false}
        onChange={event => setQuery(event.currentTarget.value)} onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Escape') {
            event.stopPropagation(); event.preventDefault();
            if (query) setQuery('');
            else event.currentTarget.blur();
            return;
          }
          if (event.key !== 'Enter') return;
          event.preventDefault();
          const first = results[0];
          if (first) activate(first.section.id, first.anchor);
        }} />
    </div>
    {query.trim() ? <div className="dw-settings-results">
      {results.length === 0 ? <p role="status">{t('workspace.search.empty')}</p> :
        <ul aria-label={t('workspace.search.results')}>{results.map(result =>
          <li key={`${result.section.id}:${result.anchor ?? ''}`}>
            <button type="button" onClick={() => activate(result.section.id, result.anchor)}>
              <span>{result.label}</span><small>{result.breadcrumb}</small>
            </button>
          </li>)}</ul>}
    </div> : <SettingsNav label={t(scope === 'user' ? 'settings.nav.label' : 'admin.nav')}
      items={sections.map(entry => ({ id: entry.id, label: t(entry.labelKey), group: t(entry.group) }))}
      activeId={activeId} onSelect={id => activate(id as SettingsEntry['id'])} />}
  </>;
}
