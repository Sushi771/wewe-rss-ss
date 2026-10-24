import {
  Button,
  Checkbox,
  Modal,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Progress,
  Tooltip,
} from '@nextui-org/react';
import type { ComponentProps, ReactNode } from 'react';

/** Shared subscription controls. Source-specific requests remain in each page. */
export function SubscriptionToolbar({ children }: { children: ReactNode }) {
  return (
    <div className="mac-toolbar feed-reading-toolbar !h-auto shrink-0 !flex-wrap !gap-2 !px-3 !py-2">
      {children}
    </div>
  );
}

export function SubscriptionSearch({
  open,
  onToggle,
  label,
  controls,
  disabled,
}: {
  open: boolean;
  onToggle: () => void;
  label: string;
  controls: string;
  disabled?: boolean;
}) {
  return (
    <Tooltip content={open ? '关闭搜索' : label}>
      <Button
        isIconOnly
        size="sm"
        variant="light"
        color={open ? 'primary' : 'default'}
        aria-label={label}
        aria-expanded={open}
        aria-controls={controls}
        isDisabled={disabled}
        className="h-8 w-8 min-w-0"
        onPress={onToggle}
      >
        <svg
          aria-hidden="true"
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.3-4.3" />
        </svg>
      </Button>
    </Tooltip>
  );
}

export function SubscriptionMore({ children }: { children: ReactNode }) {
  return (
    <Popover placement="bottom-end" className="feed-reading-more">
      <PopoverTrigger>
        <Button
          size="sm"
          variant="light"
          className="mac-action-link min-w-0 shrink-0 px-2 text-sm"
          aria-label="更多订阅操作"
        >
          更多
        </Button>
      </PopoverTrigger>
      <PopoverContent className="flex max-h-[60dvh] w-80 max-w-[calc(100vw-2rem)] flex-row flex-wrap items-center gap-3 overflow-auto rounded-lg border border-neutral-200 bg-white p-4 shadow-lg dark:border-neutral-700 dark:bg-neutral-900">
        {children}
      </PopoverContent>
    </Popover>
  );
}

export function SubscriptionDialog(props: ComponentProps<typeof Modal>) {
  return (
    <Modal
      portalContainer={
        typeof document === 'undefined' ? undefined : document.body
      }
      placement="center"
      scrollBehavior="inside"
      {...props}
      classNames={{
        backdrop: 'subscription-dialog-backdrop',
        wrapper: 'subscription-dialog-overlay',
        base: 'subscription-dialog',
        header: 'subscription-dialog-header',
        body: 'subscription-dialog-body',
        footer: 'subscription-dialog-footer',
        closeButton: 'subscription-dialog-close',
        ...props.classNames,
      }}
    />
  );
}

export function ContentSortControls({
  sort,
  onSortChange,
  direction,
  onDirectionChange,
  options,
  disabled,
  children,
}: {
  sort: string;
  onSortChange: (sort: string) => void;
  direction: 'asc' | 'desc';
  onDirectionChange: (direction: 'asc' | 'desc') => void;
  options: { value: string; label: string }[];
  disabled?: boolean;
  children?: ReactNode;
}) {
  return (
    <label className="text-default-500 flex flex-wrap items-center gap-2 px-3 py-1 text-xs">
      排序
      <select
        aria-label="文章排序"
        className="bg-background rounded border px-2 py-1"
        value={sort}
        disabled={disabled}
        onChange={(event) => onSortChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {sort === 'publishTime' && (
        <select
          aria-label="发布时间顺序"
          className="bg-background rounded border px-2 py-1"
          value={direction}
          disabled={disabled}
          onChange={(event) =>
            onDirectionChange(event.target.value as 'asc' | 'desc')
          }
        >
          <option value="desc">最新在前</option>
          <option value="asc">最早在前</option>
        </select>
      )}
      {children}
    </label>
  );
}

export function ContentSelectionHeader({
  title,
  selected,
  indeterminate,
  disabled,
  onChange,
}: {
  title: ReactNode;
  selected: boolean;
  indeterminate: boolean;
  disabled: boolean;
  onChange: (selected: boolean) => void;
}) {
  return (
    <div className="compact-list-header">
      <div className="compact-col-check">
        <Checkbox
          aria-label="全选已加载"
          size="sm"
          isSelected={selected}
          isIndeterminate={indeterminate}
          isDisabled={disabled}
          onValueChange={onChange}
        />
      </div>
      <div className="compact-col-title min-w-0 whitespace-nowrap">
        <span className="mr-2 text-xs">全选已加载</span>
        {title}
      </div>
      <div className="compact-col-metadata !hidden md:!flex">信息</div>
    </div>
  );
}

export function SubscriptionProgress({
  ariaLabel,
  compact = false,
  value,
  total,
  label,
  progressLabel,
  open,
  onOpenChange,
  summary,
  actions,
  notice,
  children,
}: {
  ariaLabel: string;
  compact?: boolean;
  value: number;
  total: number;
  label: string;
  progressLabel: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  summary: ReactNode;
  actions?: ReactNode;
  notice?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={ariaLabel}
      aria-live="polite"
      className={
        compact
          ? 'px-3 py-1 text-xs text-neutral-500'
          : 'subscription-progress-summary'
      }
    >
      {!compact && (
        <Progress
          size="sm"
          value={value}
          maxValue={Math.max(total, 1)}
          aria-label={progressLabel}
          label={label}
        />
      )}
      {notice}
      {actions}
      <details open={open} className="w-full">
        <summary
          className="cursor-pointer select-none py-1"
          aria-expanded={open}
          onClick={(event) => {
            event.preventDefault();
            onOpenChange(!open);
          }}
        >
          {summary}
        </summary>
        <div className="max-h-64 overflow-y-auto">{children}</div>
      </details>
    </section>
  );
}

/** Shared scope control; callers supply source-specific labels and eligibility. */
export function ContentExportScope({
  name,
  value,
  options,
  onChange,
  disabled = false,
}: {
  name: string;
  value: 'selected' | 'filtered' | 'all';
  options: {
    value: 'selected' | 'filtered' | 'all';
    label: string;
    disabled?: boolean;
  }[];
  onChange: (value: 'selected' | 'filtered' | 'all') => void;
  disabled?: boolean;
}) {
  return (
    <fieldset className="space-y-2" disabled={disabled}>
      <legend className="mb-2 text-sm">导出范围</legend>
      {options.map((option) => (
        <label key={option.value} className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={value === option.value}
            disabled={option.disabled}
            onChange={() => onChange(option.value)}
          />
          {option.label}
        </label>
      ))}
    </fieldset>
  );
}

export function ContentLoadMore({
  loading,
  disabled,
  error,
  onLoad,
}: {
  loading: boolean;
  disabled?: boolean;
  error?: boolean;
  onLoad: () => void;
}) {
  return (
    <div
      className="flex flex-col items-center gap-2 p-4"
      data-content-pagination
    >
      {error && (
        <p role="alert" className="text-sm text-red-600">
          加载未完成，已有内容保留。
        </p>
      )}
      <Button
        size="sm"
        variant="light"
        isDisabled={disabled}
        isLoading={loading}
        onPress={onLoad}
      >
        {loading ? '正在加载…' : error ? '重试加载' : '加载更多'}
      </Button>
    </div>
  );
}
