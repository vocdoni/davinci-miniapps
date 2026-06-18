export type PipelineStage =
  | 'idle'
  | 'validate_form'
  | 'connect_wallet'
  | 'build_census'
  | 'generate_keypair'
  | 'create_election'
  | 'done'
  | 'error';

export interface CreateFormValues {
  title: string;
  description: string;
  options: string[];
  addresses: string;
  endTime: string;
}

export interface CreateResult {
  electionId: string;
  censusRoot: string;
  addresses: string[];
}
