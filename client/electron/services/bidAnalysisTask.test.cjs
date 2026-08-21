const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { shouldInvalidateBidBriefing } = require('./bidAnalysisTask.cjs');

describe('shouldInvalidateBidBriefing', () => {
  it('invalidates when any source analysis item will rerun', () => {
    assert.equal(shouldInvalidateBidBriefing([{ id: 'projectOverview' }]), true);
    assert.equal(shouldInvalidateBidBriefing([{ id: 'projectOverview' }, { id: 'bidBriefing' }]), true);
  });

  it('keeps the briefing when only the briefing itself is requested', () => {
    assert.equal(shouldInvalidateBidBriefing([{ id: 'bidBriefing' }]), false);
    assert.equal(shouldInvalidateBidBriefing([]), false);
  });
});
