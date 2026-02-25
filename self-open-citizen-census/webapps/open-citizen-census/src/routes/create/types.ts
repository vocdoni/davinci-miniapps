export interface CreateOption {
  title: string;
  value: number;
}

export interface CreateFormState {
  processTitle: string;
  options: CreateOption[];
  country: string;
  minAge: string;
  durationHours: string;
  maxVoters: string;
}

export interface CreateOverlayState {
  dismissed: boolean;
}
