'use client';

import { useEffect, useState } from 'react';

interface CountdownUnit {
  months: number;
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}

interface EventCountdownProps {
  title?: string;
  targetDate: Date;
}

function calculateTimeRemaining(targetDate: Date): CountdownUnit {
  const now = new Date();
  const diff = targetDate.getTime() - now.getTime();

  if (diff <= 0) {
    return { months: 0, days: 0, hours: 0, minutes: 0, seconds: 0 };
  }

  const totalSeconds = Math.floor(diff / 1000);
  const totalMinutes = Math.floor(totalSeconds / 60);
  const totalHours = Math.floor(totalMinutes / 60);
  const totalDays = Math.floor(totalHours / 24);

  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfNextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const daysInCurrentMonth = Math.floor(
    (startOfNextMonth.getTime() - startOfMonth.getTime()) /
      (24 * 60 * 60 * 1000),
  );

  let months = 0;
  let remainingTime = diff;

  // Calculate months (approximate using 30 days)
  const millisecondsPerMonth = 30 * 24 * 60 * 60 * 1000;
  months = Math.floor(remainingTime / millisecondsPerMonth);
  remainingTime -= months * millisecondsPerMonth;

  // Calculate days, hours, minutes, seconds from remaining time
  const days = Math.floor(remainingTime / (24 * 60 * 60 * 1000));
  remainingTime -= days * (24 * 60 * 60 * 1000);

  const hours = Math.floor(remainingTime / (60 * 60 * 1000));
  remainingTime -= hours * (60 * 60 * 1000);

  const minutes = Math.floor(remainingTime / (60 * 1000));
  remainingTime -= minutes * (60 * 1000);

  const seconds = Math.floor(remainingTime / 1000);

  return { months, days, hours, minutes, seconds };
}

export function EventCountdown({
  title = undefined,
  targetDate,
}: EventCountdownProps) {
  const [timeRemaining, setTimeRemaining] = useState<CountdownUnit | null>(
    null,
  );

  useEffect(() => {
    setTimeRemaining(calculateTimeRemaining(targetDate));

    const interval = setInterval(() => {
      setTimeRemaining(calculateTimeRemaining(targetDate));
    }, 1000);

    return () => clearInterval(interval);
  }, [targetDate]);

  if (!timeRemaining) {
    return null;
  }

  const { months, days, hours, minutes, seconds } = timeRemaining;
  const isExpired =
    months === 0 && days === 0 && hours === 0 && minutes === 0 && seconds === 0;

  return (
    <div className="flex items-center gap-2 rounded-lg bg-primary/10 px-3 py-2 text-sm font-medium text-primary">
      <span className="whitespace-nowrap">
        {isExpired ? (
          <span>Event started!</span>
        ) : (
          <>
            {title && <span className="font-bold">{title}</span>}
            <span>{months}m </span>
            <span>{days}d </span>
            <span>{hours}h </span>
            <span>{minutes}m </span>
            <span>{seconds}s</span>
          </>
        )}
      </span>
    </div>
  );
}
