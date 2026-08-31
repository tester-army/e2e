/**
 * Compile-time drift guard between the normative driver-1 declarations
 * (spec/api/driver.d.ts) and the shipped SPI (src/driver/index.ts). The spec
 * file wins on any divergence; this file fails `check:driver-drift` the
 * moment either side changes without the other.
 *
 * Branded types (Driver, DriverHandle, full DriverContext via Target) are
 * intentionally excluded: their brand symbols are nominally distinct between
 * the spec and the implementation by design. Everything brand-free must
 * match exactly.
 */

import type * as Spec from '../../../../spec/api/driver';
import type * as Src from '../../src/driver/index.ts';

/** Exact structural equality, including readonly and optional modifiers. */
type Equals<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

type Expect<T extends true> = T;

export type Cases = [
  Expect<Equals<Spec.OperationContext, Src.OperationContext>>,
  Expect<Equals<Spec.TextPattern, Src.TextPattern>>,
  Expect<Equals<Spec.QueryKind, Src.QueryKind>>,
  Expect<Equals<Spec.SemanticQuery, Src.SemanticQuery>>,
  Expect<Equals<Spec.LocatorExpression, Src.LocatorExpression>>,
  Expect<Equals<Spec.NodeRef, Src.NodeRef>>,
  Expect<Equals<Spec.SemanticNode, Src.SemanticNode>>,
  Expect<Equals<Spec.ViewportPoint, Src.ViewportPoint>>,
  Expect<Equals<Spec.ObservationPixels, Src.ObservationPixels>>,
  Expect<Equals<Spec.ObserveOptions, Src.ObserveOptions>>,
  Expect<Equals<Spec.Observation, Src.Observation>>,
  Expect<Equals<Spec.LocatorAction, Src.LocatorAction>>,
  Expect<Equals<Spec.DriverErrorCode, Src.DriverErrorCode>>,
  Expect<Equals<Spec.DriverError, Src.DriverError>>,
  Expect<Equals<Spec.DriverState, Src.DriverState>>,
  Expect<Equals<Spec.DriverCapabilities, Src.DriverCapabilities>>,
  Expect<Equals<Spec.CleanupContext, Src.CleanupContext>>,
  Expect<Equals<Omit<Spec.DriverContext, 'target'>, Omit<Src.DriverContext, 'target'>>>,
  Expect<Equals<Spec.DriverApp, Src.DriverApp>>,
  Expect<Equals<Spec.DriverScreen, Src.DriverScreen>>,
  Expect<Equals<Spec.DriverAgentActions, Src.DriverAgentActions>>,
  Expect<Equals<Spec.DriverWebRoute, Src.DriverWebRoute>>,
  Expect<Equals<Spec.DriverWebResponse, Src.DriverWebResponse>>,
  Expect<Equals<Spec.DriverDialog, Src.DriverDialog>>,
  Expect<Equals<Spec.DriverWeb, Src.DriverWeb>>,
  Expect<Equals<Spec.DriverArtifacts, Src.DriverArtifacts>>,
  Expect<Equals<Spec.DriverRuntime, Src.DriverRuntime>>,
  Expect<Equals<Spec.DriverSession, Src.DriverSession>>,
];
