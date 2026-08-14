import React from 'react';

export function CardSkeleton({ count = 4 }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="p-5 bg-surface-container-lowest rounded-3xl border border-outline-variant shadow-elevation-1">
          <div className="h-4 w-28 m3-skeleton rounded-full mb-3"></div>
          <div className="h-8 w-36 m3-skeleton rounded-xl mb-2"></div>
          <div className="h-3 w-20 m3-skeleton rounded-full"></div>
        </div>
      ))}
    </div>
  );
}

export function TableSkeleton({ rows = 6, cols = 5 }) {
  return (
    <div className="bg-surface-container-lowest rounded-3xl border border-outline-variant shadow-elevation-1 p-5">
      <div className="flex justify-between items-center mb-6">
        <div className="h-6 w-48 m3-skeleton rounded-full"></div>
        <div className="h-9 w-64 m3-skeleton rounded-full"></div>
      </div>
      <div className="space-y-3">
        <div className="h-10 m3-skeleton rounded-2xl"></div>
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="h-12 m3-skeleton rounded-2xl"></div>
        ))}
      </div>
    </div>
  );
}
