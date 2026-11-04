const { manifestToolMap, isAgentsOnlyTool } = require('./manifest');

describe('isAgentsOnlyTool', () => {
  it.each([
    'ask_user_question',
    'schedule_chat',
    'create_schedule',
    'list_schedules',
    'get_schedule',
    'update_schedule',
    'delete_schedule',
  ])('flags %s in both wire shapes', (name) => {
    // Guard the data too: the whole assistants-rejection path keys on this flag.
    expect(manifestToolMap[name]?.agentsOnly).toBe(true);

    expect(isAgentsOnlyTool(name)).toBe(true);
    expect(isAgentsOnlyTool({ type: 'function', function: { name } })).toBe(true);
  });

  it('does not flag ordinary manifest tools, unknown tools, or malformed inputs', () => {
    expect(isAgentsOnlyTool('calculator')).toBe(false);
    expect(isAgentsOnlyTool('nonexistent_tool')).toBe(false);
    expect(isAgentsOnlyTool({ type: 'function', function: { name: 'calculator' } })).toBe(false);
    expect(isAgentsOnlyTool(undefined)).toBe(false);
    expect(isAgentsOnlyTool({})).toBe(false);
    expect(isAgentsOnlyTool({ type: 'code_interpreter' })).toBe(false);
  });
});
