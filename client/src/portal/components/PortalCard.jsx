import React from 'react';
import Card from '../../components/ui/Card.jsx';

// Rebuild — Implementation Spec §18: a thin wrapper around the EXISTING
// staff Card component with the padding every portal page repeated inline.
export default function PortalCard({ children, style, ...rest }) {
  return (
    <Card style={{ padding: '16px', ...style }} {...rest}>
      {children}
    </Card>
  );
}
