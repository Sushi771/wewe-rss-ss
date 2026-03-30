import React from 'react';
import {
  Dropdown,
  DropdownTrigger,
  DropdownMenu,
  DropdownItem,
} from '@nextui-org/react';
import { statusMap } from '@web/constants';

export function StatusDropdown({
  value = 1,
  onChange,
}: {
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <Dropdown>
      <DropdownTrigger>
        <div className="hover:text-primary flex cursor-pointer items-center gap-1 text-[14px] text-neutral-600 transition-colors dark:text-neutral-400">
          {statusMap[value].label}
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </div>
      </DropdownTrigger>
      <DropdownMenu
        disabledKeys={['0']}
        aria-label="状态设置"
        variant="flat"
        disallowEmptySelection
        selectionMode="single"
        selectedKeys={[`${value}`]}
        onSelectionChange={(keys) => {
          onChange(+Array.from(keys)[0]);
        }}
      >
        {Object.entries(statusMap).map(([key, value]) => {
          return (
            <DropdownItem color={value.color} key={`${key}`} value={`${key}`}>
              {value.label}
            </DropdownItem>
          );
        })}
      </DropdownMenu>
    </Dropdown>
  );
}
