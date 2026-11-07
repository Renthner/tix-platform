import { respondTanAction } from '@/server/admin/banking-actions';
import type { PendingChallenge } from '@/server/admin/banking-queries';
import { TanPrompt } from './connection-actions';

/** Server component: open TAN challenges with their prompts (actions bound per challenge). */
export function TanChallenges({ challenges }: { challenges: PendingChallenge[] }) {
  if (challenges.length === 0) return null;
  return (
    <div className="space-y-3">
      {challenges.map((c) => (
        <TanPrompt
          key={c.id}
          challenge={{
            id: c.id,
            connectionName: c.connectionName,
            status: c.status,
            tanMethod: c.tanMethod,
            challengeText: c.challengeText,
            challengeMediaMimeType: c.challengeMediaMimeType,
            challengeMediaBase64: c.challengeMediaBase64,
            isDecoupled: c.isDecoupled,
            expiresAt: c.expiresAt.toISOString(),
          }}
          submitTan={respondTanAction.bind(null, c.id, 'TAN')}
          confirmApproval={respondTanAction.bind(null, c.id, 'DECOUPLED_CONFIRMED')}
          cancel={respondTanAction.bind(null, c.id, 'CANCELLED')}
        />
      ))}
    </div>
  );
}
