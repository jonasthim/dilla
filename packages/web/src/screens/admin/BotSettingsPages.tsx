import { BotSection } from './BotSection.tsx';
import type { SectionProps } from './shared.ts';

export { BotSettingsProvider } from './bot-settings-context.tsx';

export function BotPage(props: SectionProps): React.JSX.Element { return <BotSection {...props} page="bot" />; }
export function WelcomePage(props: SectionProps): React.JSX.Element { return <BotSection {...props} page="welcome" />; }
export function JoinRolesPage(props: SectionProps): React.JSX.Element { return <BotSection {...props} page="joinRoles" />; }
export function MusicPage(props: SectionProps): React.JSX.Element { return <BotSection {...props} page="music" />; }
export function AutomoderationPage(props: SectionProps): React.JSX.Element { return <BotSection {...props} page="automoderation" />; }
export function ModerationLogPage(props: SectionProps): React.JSX.Element { return <BotSection {...props} page="moderationLog" />; }
