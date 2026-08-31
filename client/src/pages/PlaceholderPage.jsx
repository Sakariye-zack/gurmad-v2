import React from 'react';
import { PageHeader, EmptyState } from '../components/ui/index.js';

export default function PlaceholderPage({ icon, title, subtitle }) {
  return (
    <div>
      <PageHeader icon={icon} title={title} subtitle={subtitle} />
      <EmptyState title="Not yet built" subtitle="This module is specified but awaits its own implementation pass, per the approved one-module-at-a-time sequence." />
    </div>
  );
}
