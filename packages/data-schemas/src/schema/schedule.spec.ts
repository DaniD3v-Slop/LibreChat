import mongoose from 'mongoose';
import type { IScheduleDocument } from '~/types/schedule';
import scheduleSchema from './schedule';

const Schedule = mongoose.model<IScheduleDocument>('ScheduleTargetSchemaTest', scheduleSchema);

function schedule(target: string, conversationId?: string) {
  return new Schedule({
    id: 'sched-schema',
    user: new mongoose.Types.ObjectId(),
    name: 'Follow up',
    prompt: 'Check progress',
    agent_id: 'agent-1',
    cadence: { frequency: 'once', at: '2099-01-01T08:00' },
    timezone: 'UTC',
    target,
    conversationId,
  });
}

describe('schedule destination schema', () => {
  it.each(['continue', 'steer'])('preserves the %s destination and conversation', (target) => {
    const doc = schedule(target, 'chat-1');

    expect(doc.validateSync()).toBeUndefined();
    expect(doc.toObject()).toMatchObject({ target, conversationId: 'chat-1' });
  });

  it.each(['continue', 'steer'])('requires a conversation for %s', (target) => {
    expect(schedule(target).validateSync()?.errors).toHaveProperty('conversationId');
  });

  it('preserves new-chat schedules without a conversation', () => {
    const doc = schedule('new');

    expect(doc.validateSync()).toBeUndefined();
    expect(doc.toObject()).not.toHaveProperty('conversationId');
    expect(doc.toObject()).not.toHaveProperty('description');
    expect(doc.toObject()).not.toHaveProperty('originConversationId');
  });
});

describe('schedule metadata storage', () => {
  it('enforces the description size bound at storage', () => {
    const doc = new Schedule({ ...schedule('new').toObject(), description: 'x'.repeat(2001) });
    expect(doc.validateSync()?.errors).toHaveProperty('description');
  });
});
