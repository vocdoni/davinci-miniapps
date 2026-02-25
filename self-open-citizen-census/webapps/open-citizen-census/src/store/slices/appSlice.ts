import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';

import type { AppCompatibilityState, RouteContext } from '../../types/state';
import { parseRouteFromPath } from '../../utils/route';

export const syncRouteFromLocation = createAsyncThunk<RouteContext, string>(
  'app/syncRouteFromLocation',
  async (pathname) => parseRouteFromPath(pathname)
);

const initialState: AppCompatibilityState = {
  route: {
    name: 'create',
    processId: '',
    contextPresent: false,
    contextValid: false,
  },
  create: {
    step: 1,
    submitting: false,
    dirty: false,
    statusMessage: '',
    statusError: false,
  },
  voteResolution: {
    processId: '',
    statusCode: null,
    isAcceptingVotes: false,
    title: '',
    description: '',
    censusContract: '',
    censusUri: '',
    endDateMs: null,
    onchainWeight: '0',
    sequencerWeight: '0',
    readinessCheckedAt: null,
  },
  voteSelf: {
    scopeSeed: '',
    minAge: null,
    country: '',
    link: '',
    generating: false,
    autoTriggerKey: '',
  },
  voteBallot: {
    loading: false,
    submitting: false,
    hasVoted: false,
    submissionId: '',
    submissionStatus: '',
  },
  managedWallet: {
    address: '',
    source: '',
    privateVisible: false,
  },
};

const appSlice = createSlice({
  name: 'app',
  initialState,
  reducers: {
    setRoute(state, action: PayloadAction<RouteContext>) {
      state.route = action.payload;
    },
  },
  extraReducers: (builder) => {
    builder.addCase(syncRouteFromLocation.fulfilled, (state, action) => {
      state.route = action.payload;
    });
  },
});

export const { setRoute } = appSlice.actions;
export default appSlice.reducer;
