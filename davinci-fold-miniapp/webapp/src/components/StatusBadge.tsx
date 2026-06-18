import { electionStatusColor, electionStatusLabel } from '../lib/dfc';
import type { ElectionStatus } from '../lib/types';

interface Props {
  status: ElectionStatus;
}

export default function StatusBadge({ status }: Props) {
  const color = electionStatusColor(status);
  return (
    <span className={`status-badge ${color}`}>
      <span className="status-dot" />
      {electionStatusLabel(status)}
    </span>
  );
}
