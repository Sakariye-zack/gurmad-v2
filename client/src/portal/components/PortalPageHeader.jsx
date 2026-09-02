import React from 'react';
import PageHeader from '../../components/ui/PageHeader.jsx';

// Rebuild — Implementation Spec §18: a thin wrapper around the EXISTING
// staff PageHeader component, not a new visual language. Replaces the
// repeated inline-<h2> pattern every original portal page hand-rolled.
export default function PortalPageHeader(props) {
  return <PageHeader {...props} />;
}
