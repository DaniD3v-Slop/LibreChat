import userEvent from '@testing-library/user-event';
import { render, screen } from '@testing-library/react';
import type { TSchedule, TScheduleCadence } from 'librechat-data-provider';
import SchedulePanel from '../SchedulePanel';

const mockSchedules: { schedules: Partial<TSchedule>[] } = { schedules: [] };

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: { count?: number }) =>
    values?.count != null ? `${key}:${values.count}` : key,
  useHasAccess: () => true,
  useScrollFade: () => ({ attach: () => undefined, hasMore: false }),
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en-US' } }),
}));

jest.mock('~/data-provider', () => ({
  useSchedulesQuery: () => ({
    data: { schedules: mockSchedules.schedules, limits: {} },
    isLoading: false,
    isError: false,
    refetch: jest.fn(),
  }),
}));

jest.mock('~/Providers', () => ({
  useChatContext: () => ({ conversation: null }),
}));

jest.mock('../useScheduleProjects', () => ({
  useChatProjectNames: () => new Map(),
}));

jest.mock('../ScheduleCard', () => ({
  __esModule: true,
  default: ({ schedule }: { schedule: TSchedule }) => <span>{schedule.name}</span>,
}));

jest.mock('../ScheduleDialog', () => ({
  __esModule: true,
  default: () => null,
}));

const once: TScheduleCadence = { frequency: 'once', at: '2026-11-01T09:00:00.000Z' };
const daily: TScheduleCadence = { frequency: 'daily', hour: 9, minute: 0 };

describe('SchedulePanel', () => {
  beforeEach(() => {
    mockSchedules.schedules = [
      { id: 'a', name: 'Daily digest', enabled: true, cadence: daily } as Partial<TSchedule>,
      {
        id: 'b',
        name: 'Delivered reminder',
        enabled: false,
        disabledReason: 'completed',
        cadence: once,
      } as Partial<TSchedule>,
      {
        id: 'c',
        name: 'Pending reminder',
        enabled: true,
        cadence: once,
      } as Partial<TSchedule>,
      {
        id: 'd',
        name: 'Paused digest',
        enabled: false,
        cadence: daily,
      } as Partial<TSchedule>,
    ];
  });

  it('hides delivered one-time schedules until asked', async () => {
    render(<SchedulePanel />);

    expect(screen.getByText('Daily digest')).toBeInTheDocument();
    expect(screen.getByText('Pending reminder')).toBeInTheDocument();
    expect(screen.getByText('Paused digest')).toBeInTheDocument();
    expect(screen.queryByText('Delivered reminder')).not.toBeInTheDocument();

    await userEvent.click(
      screen.getByRole('button', { name: 'com_ui_schedules_show_delivered:1' }),
    );
    expect(screen.getByText('Delivered reminder')).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole('button', { name: 'com_ui_schedules_hide_delivered:1' }),
    );
    expect(screen.queryByText('Delivered reminder')).not.toBeInTheDocument();
  });

  it('offers no toggle when nothing has been delivered', () => {
    mockSchedules.schedules = mockSchedules.schedules.filter((schedule) => schedule.id !== 'b');
    render(<SchedulePanel />);

    expect(
      screen.queryByRole('button', { name: /com_ui_schedules_show_delivered/ }),
    ).not.toBeInTheDocument();
  });

  it('shows the empty state beside the toggle when every schedule was delivered', () => {
    mockSchedules.schedules = mockSchedules.schedules.filter((schedule) => schedule.id === 'b');
    render(<SchedulePanel />);

    expect(screen.getByText('com_ui_no_schedules_title')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'com_ui_schedules_show_delivered:1' }),
    ).toBeInTheDocument();
  });
});
