import http from 'node:http';
import { Goal, Joint, Link, Solver, DOF, SOLVE_STATUS_NAMES } from 'closed-chain-ik/src/index.js';
import { mat3, quat, vec3 } from 'gl-matrix';

const HOST = process.env.PREVIZ_SOLVER_HOST || '127.0.0.1';
const PORT = Number(process.env.PREVIZ_SOLVER_PORT || '8765');

const LOCAL_AXES = [
	[ 1, 0, 0 ],
	[ 0, 1, 0 ],
	[ 0, 0, 1 ],
];

function clamp(value, min, max) {
	return Math.min(max, Math.max(min, value));
}

function clampMagnitude(values, maxMagnitude) {
	const magnitude = Math.hypot(values[ 0 ], values[ 1 ], values[ 2 ]);
	if (magnitude <= maxMagnitude || magnitude < 1e-6) {
		return values;
	}

	const scale = maxMagnitude / magnitude;
	return values.map(v => v * scale);
}

function normalizeOrFallback(values, fallback) {
	const out = vec3.fromValues(values[ 0 ], values[ 1 ], values[ 2 ]);
	if (vec3.length(out) < 1e-6) {
		return vec3.fromValues(fallback[ 0 ], fallback[ 1 ], fallback[ 2 ]);
	}
	vec3.normalize(out, out);
	return out;
}

function rowMajorMat3ToQuat(values) {
	const m = mat3.fromValues(
		values[ 0 ], values[ 3 ], values[ 6 ],
		values[ 1 ], values[ 4 ], values[ 7 ],
		values[ 2 ], values[ 5 ], values[ 8 ],
	);
	const out = quat.create();
	quat.fromMat3(out, m);
	quat.normalize(out, out);
	return out;
}

function quatToRowMajorMat3(q) {
	const m = mat3.create();
	mat3.fromQuat(m, q);
	return [
		[ m[ 0 ], m[ 3 ], m[ 6 ] ],
		[ m[ 1 ], m[ 4 ], m[ 7 ] ],
		[ m[ 2 ], m[ 5 ], m[ 8 ] ],
	];
}

function quatToEulerXYZ(q) {
	const [ x, y, z, w ] = q;
	const sinr = 2 * (w * x + y * z);
	const cosr = 1 - 2 * (x * x + y * y);
	const ex = Math.atan2(sinr, cosr);

	const sinp = clamp(2 * (w * y - z * x), -1, 1);
	const ey = Math.asin(sinp);

	const siny = 2 * (w * z + x * y);
	const cosy = 1 - 2 * (y * y + z * z);
	const ez = Math.atan2(siny, cosy);
	return [ ex, ey, ez ];
}

function wxyzToXyzw(values) {
	return [ values[ 1 ], values[ 2 ], values[ 3 ], values[ 0 ] ];
}

function axisVecForDoF(dof) {
	if (dof === DOF.EX) {
		return LOCAL_AXES[ 0 ];
	}
	if (dof === DOF.EY) {
		return LOCAL_AXES[ 1 ];
	}
	return LOCAL_AXES[ 2 ];
}

function buildChildren(parents) {
	const children = Array.from({ length: parents.length }, () => []);
	let rootIndex = -1;
	for (let i = 0; i < parents.length; i++) {
		const parent = parents[ i ];
		if (parent < 0) {
			if (rootIndex === -1) {
				rootIndex = i;
			}
			continue;
		}
		children[ parent ].push(i);
	}
	return { children, rootIndex };
}

function computeLocalPose(globalPositions, globalQuats, parents) {
	const localPositions = Array.from({ length: globalPositions.length }, () => [ 0, 0, 0 ]);
	const localQuats = Array.from({ length: globalQuats.length }, () => quat.create());
	for (let i = 0; i < globalPositions.length; i++) {
		const parent = parents[ i ];
		if (parent < 0) {
			localPositions[ i ] = [ ...globalPositions[ i ] ];
			localQuats[ i ] = quat.clone(globalQuats[ i ]);
			continue;
		}

		const invParentQuat = quat.create();
		quat.invert(invParentQuat, globalQuats[ parent ]);

		const delta = vec3.fromValues(
			globalPositions[ i ][ 0 ] - globalPositions[ parent ][ 0 ],
			globalPositions[ i ][ 1 ] - globalPositions[ parent ][ 1 ],
			globalPositions[ i ][ 2 ] - globalPositions[ parent ][ 2 ],
		);
		vec3.transformQuat(delta, delta, invParentQuat);
		localPositions[ i ] = [ delta[ 0 ], delta[ 1 ], delta[ 2 ] ];

		const localQuat = quat.create();
		quat.multiply(localQuat, invParentQuat, globalQuats[ i ]);
		quat.normalize(localQuat, localQuat);
		localQuats[ i ] = localQuat;
	}
	return { localPositions, localQuats };
}

function classifyJoint(name) {
	const lower = name.toLowerCase();
	const side = lower.includes('left') ? 'left' : lower.includes('right') ? 'right' : 'center';
	const has = token => lower.includes(token);

	if (has('thumb') || has('index') || has('middle') || has('ring') || has('pinky')) {
		return { region: 'finger', side };
	}
	if (has('eye') || has('jaw')) {
		return { region: 'face', side };
	}
	if (has('headend') || has('toeend')) {
		return { region: 'end', side };
	}
	if (lower === 'hips' || has('pelvis')) {
		return { region: 'hips', side: 'center' };
	}
	if (has('spine') || has('chest')) {
		return { region: 'spine', side: 'center' };
	}
	if (has('neck')) {
		return { region: 'neck', side: 'center' };
	}
	if (lower === 'head') {
		return { region: 'head', side: 'center' };
	}
	if (has('shoulder') || has('clav')) {
		return { region: 'shoulder', side };
	}
	if (has('forearm') || has('lowerarm') || has('elbow')) {
		return { region: 'forearm', side };
	}
	if (has('arm')) {
		return { region: 'arm', side };
	}
	if (has('hand')) {
		return { region: 'hand', side };
	}
	if (has('shin') || has('calf') || has('knee')) {
		return { region: 'shin', side };
	}
	if (has('upleg') || (has('leg') && !has('toe') && !has('foot') && !has('shin'))) {
		return { region: 'leg', side };
	}
	if (has('foot')) {
		return { region: 'foot', side };
	}
	if (has('toe')) {
		return { region: 'toe', side };
	}

	return { region: 'other', side };
}

function findJointIndexByRegion(metadata, region, side = null) {
	return metadata.findIndex(meta => meta.region === region && (side === null || meta.side === side));
}

function descendantIndices(startIndex, children) {
	const indices = [];
	const stack = [ startIndex ];
	while (stack.length) {
		const index = stack.pop();
		indices.push(index);
		for (const child of children[ index ]) {
			stack.push(child);
		}
	}
	return indices;
}

function findDescendantByRegion(startIndex, region, metadata, children) {
	const stack = [ ...children[ startIndex ] ];
	while (stack.length) {
		const index = stack.pop();
		if (metadata[ index ].region === region) {
			return index;
		}
		for (const child of children[ index ]) {
			stack.push(child);
		}
	}
	return -1;
}

function computeCharacterAxes(globalPositions, metadata) {
	const hipsIndex = findJointIndexByRegion(metadata, 'hips');
	const chestIndex = findJointIndexByRegion(metadata, 'spine');
	const headIndex = findJointIndexByRegion(metadata, 'head');
	const leftShoulderIndex = findJointIndexByRegion(metadata, 'shoulder', 'left');
	const rightShoulderIndex = findJointIndexByRegion(metadata, 'shoulder', 'right');
	const leftLegIndex = findJointIndexByRegion(metadata, 'leg', 'left');
	const rightLegIndex = findJointIndexByRegion(metadata, 'leg', 'right');

	const hipsPos = hipsIndex >= 0 ? globalPositions[ hipsIndex ] : [ 0, 0, 0 ];
	const chestPos = chestIndex >= 0 ? globalPositions[ chestIndex ] : headIndex >= 0 ? globalPositions[ headIndex ] : [ 0, 1, 0 ];
	const up = normalizeOrFallback([
		chestPos[ 0 ] - hipsPos[ 0 ],
		chestPos[ 1 ] - hipsPos[ 1 ],
		chestPos[ 2 ] - hipsPos[ 2 ],
	], [ 0, 1, 0 ]);

	let right = null;
	if (leftShoulderIndex >= 0 && rightShoulderIndex >= 0) {
		right = normalizeOrFallback([
			globalPositions[ rightShoulderIndex ][ 0 ] - globalPositions[ leftShoulderIndex ][ 0 ],
			globalPositions[ rightShoulderIndex ][ 1 ] - globalPositions[ leftShoulderIndex ][ 1 ],
			globalPositions[ rightShoulderIndex ][ 2 ] - globalPositions[ leftShoulderIndex ][ 2 ],
		], [ 1, 0, 0 ]);
	} else if (leftLegIndex >= 0 && rightLegIndex >= 0) {
		right = normalizeOrFallback([
			globalPositions[ rightLegIndex ][ 0 ] - globalPositions[ leftLegIndex ][ 0 ],
			globalPositions[ rightLegIndex ][ 1 ] - globalPositions[ leftLegIndex ][ 1 ],
			globalPositions[ rightLegIndex ][ 2 ] - globalPositions[ leftLegIndex ][ 2 ],
		], [ 1, 0, 0 ]);
	} else {
		right = vec3.fromValues(1, 0, 0);
	}

	const forward = vec3.create();
	vec3.cross(forward, right, up);
	if (vec3.length(forward) < 1e-6) {
		vec3.set(forward, 0, 0, 1);
	} else {
		vec3.normalize(forward, forward);
	}

	const correctedRight = vec3.create();
	vec3.cross(correctedRight, up, forward);
	vec3.normalize(correctedRight, correctedRight);

	return { up, right: correctedRight, forward };
}

function rotateAroundLocalAxis(localQuat, axisDof, angle) {
	const deltaQuat = quat.create();
	quat.setAxisAngle(deltaQuat, axisVecForDoF(axisDof), angle);
	const result = quat.create();
	quat.multiply(result, localQuat, deltaQuat);
	quat.normalize(result, result);
	return result;
}

function recomputeSubtreeWorldPose(index, overrideLocalQuat, parents, children, localPositions, localQuats, globalPositions, globalQuats) {
	const outPositions = globalPositions.map(pos => [ ...pos ]);
	const outQuats = globalQuats.map(q => quat.clone(q));

	function update(nodeIndex, parentQuat, parentPos) {
		const localQuat = nodeIndex === index ? overrideLocalQuat : localQuats[ nodeIndex ];
		const worldQuat = quat.create();
		if (parents[ nodeIndex ] < 0) {
			quat.copy(worldQuat, localQuat);
			outPositions[ nodeIndex ] = [ ...localPositions[ nodeIndex ] ];
		} else {
			quat.multiply(worldQuat, parentQuat, localQuat);
			const offset = vec3.fromValues(
				localPositions[ nodeIndex ][ 0 ],
				localPositions[ nodeIndex ][ 1 ],
				localPositions[ nodeIndex ][ 2 ],
			);
			vec3.transformQuat(offset, offset, parentQuat);
			outPositions[ nodeIndex ] = [
				parentPos[ 0 ] + offset[ 0 ],
				parentPos[ 1 ] + offset[ 1 ],
				parentPos[ 2 ] + offset[ 2 ],
			];
		}
		outQuats[ nodeIndex ] = worldQuat;
		for (const child of children[ nodeIndex ]) {
			update(child, worldQuat, outPositions[ nodeIndex ]);
		}
	}

	const parentIndex = parents[ index ];
	if (parentIndex < 0) {
		update(index, quat.create(), [ 0, 0, 0 ]);
	} else {
		update(index, globalQuats[ parentIndex ], globalPositions[ parentIndex ]);
	}

	return { positions: outPositions, quats: outQuats };
}

function chooseHingeAxis(index, metadata, globalQuats, characterAxes) {
	const worldAxes = LOCAL_AXES.map(axis => {
		const out = vec3.fromValues(axis[ 0 ], axis[ 1 ], axis[ 2 ]);
		vec3.transformQuat(out, out, globalQuats[ index ]);
		vec3.normalize(out, out);
		return out;
	});

	let preferred = characterAxes.right;
	if (metadata[ index ].region === 'forearm') {
		preferred = characterAxes.right;
	}
	if (metadata[ index ].region === 'shin') {
		preferred = characterAxes.right;
	}

	let bestDof = DOF.EX;
	let bestScore = -Infinity;
	for (const [ axisIndex, worldAxis ] of worldAxes.entries()) {
		const score = Math.abs(vec3.dot(worldAxis, preferred));
		if (score > bestScore) {
			bestScore = score;
			bestDof = DOF.EX + axisIndex;
		}
	}
	return bestDof;
}

function chooseHingeFlexSign({
	index,
	endIndex,
	primaryDof,
	parents,
	children,
	localPositions,
	localQuats,
	globalPositions,
	globalQuats,
	preferredBias,
}) {
	if (endIndex < 0) {
		return 1;
	}

	const originalEnd = globalPositions[ endIndex ];
	const jointPos = globalPositions[ index ];
	const towardJoint = normalizeOrFallback([
		jointPos[ 0 ] - originalEnd[ 0 ] + preferredBias[ 0 ],
		jointPos[ 1 ] - originalEnd[ 1 ] + preferredBias[ 1 ],
		jointPos[ 2 ] - originalEnd[ 2 ] + preferredBias[ 2 ],
	], [ 0, 1, 0 ]);

	let bestSign = 1;
	let bestScore = -Infinity;
	for (const sign of [ 1, -1 ]) {
		const testQuat = rotateAroundLocalAxis(localQuats[ index ], primaryDof, 0.22 * sign);
		const simulated = recomputeSubtreeWorldPose(
			index,
			testQuat,
			parents,
			children,
			localPositions,
			localQuats,
			globalPositions,
			globalQuats,
		);
		const displaced = [
			simulated.positions[ endIndex ][ 0 ] - originalEnd[ 0 ],
			simulated.positions[ endIndex ][ 1 ] - originalEnd[ 1 ],
			simulated.positions[ endIndex ][ 2 ] - originalEnd[ 2 ],
		];
		const score = vec3.dot(normalizeOrFallback(displaced, [ 0, 0, 0 ]), towardJoint);
		if (score > bestScore) {
			bestScore = score;
			bestSign = sign;
		}
	}

	return bestSign;
}

function setAxisLimitAroundCurrent(joint, dof, current, minus, plus) {
	joint.setMinLimit(dof, current - minus);
	joint.setMaxLimit(dof, current + plus);
	joint.setRestPoseValue(dof, current);
}

function freezeJoint(joint, currentEuler) {
	setAxisLimitAroundCurrent(joint, DOF.EX, currentEuler[ 0 ], 0, 0);
	setAxisLimitAroundCurrent(joint, DOF.EY, currentEuler[ 1 ], 0, 0);
	setAxisLimitAroundCurrent(joint, DOF.EZ, currentEuler[ 2 ], 0, 0);
}

function setRotationEnvelope(joint, currentEuler, ranges) {
	setAxisLimitAroundCurrent(joint, DOF.EX, currentEuler[ 0 ], ranges[ 0 ], ranges[ 0 ]);
	setAxisLimitAroundCurrent(joint, DOF.EY, currentEuler[ 1 ], ranges[ 1 ], ranges[ 1 ]);
	setAxisLimitAroundCurrent(joint, DOF.EZ, currentEuler[ 2 ], ranges[ 2 ], ranges[ 2 ]);
}

function buildControlState(payload, globalPositions, metadata) {
	const effectors = (payload.effectors || []).map(effector => ({
		controlName: effector.control_name || metadata[ Number(effector.joint_index) ]?.name || '',
		jointIndex: Number(effector.joint_index),
		targetPosition: effector.target_position.map(Number),
	}));
	const rotationTargets = (payload.rotation_targets || []).map(target => ({
		controlName: target.control_name || metadata[ Number(target.joint_index) ]?.name || '',
		jointIndex: Number(target.joint_index),
		targetQuaternion: quat.normalize(quat.create(), wxyzToXyzw(target.target_wxyz)),
	}));

	const explicitHips = effectors.find(item => item.controlName === 'hips');
	const supportingFeet = effectors.filter(item => item.controlName === 'left_foot' || item.controlName === 'right_foot');
	const activeHands = effectors.filter(item => item.controlName === 'left_hand' || item.controlName === 'right_hand');

	if (!explicitHips && supportingFeet.length > 0 && activeHands.length > 0) {
		const hipsIndex = findJointIndexByRegion(metadata, 'hips');
		if (hipsIndex >= 0) {
			const avgDelta = [ 0, 0, 0 ];
			for (const hand of activeHands) {
				const original = globalPositions[ hand.jointIndex ];
				avgDelta[ 0 ] += hand.targetPosition[ 0 ] - original[ 0 ];
				avgDelta[ 1 ] += hand.targetPosition[ 1 ] - original[ 1 ];
				avgDelta[ 2 ] += hand.targetPosition[ 2 ] - original[ 2 ];
			}
			avgDelta[ 0 ] /= activeHands.length;
			avgDelta[ 1 ] /= activeHands.length;
			avgDelta[ 2 ] /= activeHands.length;
			const assistedDelta = clampMagnitude([
				avgDelta[ 0 ] * 0.55,
				avgDelta[ 1 ] * 0.3,
				avgDelta[ 2 ] * 0.55,
			], 0.28);
			effectors.push({
				controlName: 'hips_assist',
				jointIndex: hipsIndex,
				targetPosition: [
					globalPositions[ hipsIndex ][ 0 ] + assistedDelta[ 0 ],
					globalPositions[ hipsIndex ][ 1 ] + assistedDelta[ 1 ],
					globalPositions[ hipsIndex ][ 2 ] + assistedDelta[ 2 ],
				],
			});
		}
	}

	return { effectors, rotationTargets };
}

function applyJointPolicies({
	jointFrames,
	metadata,
	children,
	parents,
	localPositions,
	localQuats,
	globalPositions,
	globalQuats,
	characterAxes,
	controlState,
}) {
	const activeRotationIndices = new Set(controlState.rotationTargets.map(target => target.jointIndex));
	const activeTranslationIndices = new Set(controlState.effectors.map(target => target.jointIndex));

	for (let index = 0; index < metadata.length; index++) {
		const joint = jointFrames[ index ];
		const { region } = metadata[ index ];
		const currentEuler = quatToEulerXYZ(localQuats[ index ]);

		if (region === 'hips') {
			joint.setMinLimit(DOF.EX, currentEuler[ 0 ] - 0.7);
			joint.setMaxLimit(DOF.EX, currentEuler[ 0 ] + 0.7);
			joint.setMinLimit(DOF.EY, currentEuler[ 1 ] - 0.9);
			joint.setMaxLimit(DOF.EY, currentEuler[ 1 ] + 0.9);
			joint.setMinLimit(DOF.EZ, currentEuler[ 2 ] - 0.55);
			joint.setMaxLimit(DOF.EZ, currentEuler[ 2 ] + 0.55);
			joint.setRestPoseValues(
				localPositions[ index ][ 0 ],
				localPositions[ index ][ 1 ],
				localPositions[ index ][ 2 ],
				currentEuler[ 0 ],
				currentEuler[ 1 ],
				currentEuler[ 2 ],
			);
			continue;
		}

		if (region === 'finger' || region === 'face' || region === 'end') {
			freezeJoint(joint, currentEuler);
			continue;
		}

		if (region === 'toe') {
			setRotationEnvelope(joint, currentEuler, [ 0.12, 0.12, 0.12 ]);
			continue;
		}

		if (region === 'foot') {
			const hasExplicitRotation = activeRotationIndices.has(index);
			setRotationEnvelope(joint, currentEuler, hasExplicitRotation ? [ 0.5, 0.45, 0.45 ] : [ 0.2, 0.18, 0.18 ]);
			continue;
		}

		if (region === 'hand') {
			setRotationEnvelope(joint, currentEuler, [ 0.45, 0.45, 0.45 ]);
			continue;
		}

		if (region === 'spine') {
			setRotationEnvelope(joint, currentEuler, [ 0.4, 0.35, 0.35 ]);
			continue;
		}

		if (region === 'neck') {
			setRotationEnvelope(joint, currentEuler, [ 0.3, 0.35, 0.3 ]);
			continue;
		}

		if (region === 'head') {
			setRotationEnvelope(joint, currentEuler, [ 0.45, 0.55, 0.45 ]);
			continue;
		}

		if (region === 'shoulder') {
			setRotationEnvelope(joint, currentEuler, [ 0.8, 0.9, 0.8 ]);
			continue;
		}

		if (region === 'arm' || region === 'leg') {
			setRotationEnvelope(joint, currentEuler, [ 1.2, 1.0, 1.0 ]);
			continue;
		}

		if (region === 'forearm' || region === 'shin') {
			const primaryDof = chooseHingeAxis(index, metadata, globalQuats, characterAxes);
			const endRegion = region === 'forearm' ? 'hand' : 'foot';
			const endIndex = findDescendantByRegion(index, endRegion, metadata, children);
			const preferredBias = region === 'forearm'
				? [ -0.15 * characterAxes.forward[ 0 ], 0.05 * characterAxes.up[ 1 ], -0.15 * characterAxes.forward[ 2 ] ]
				: [ 0.1 * characterAxes.up[ 0 ], 0.18 * characterAxes.up[ 1 ], 0.1 * characterAxes.up[ 2 ] ];
			const flexSign = chooseHingeFlexSign({
				index,
				endIndex,
				primaryDof,
				parents,
				children,
				localPositions,
				localQuats,
				globalPositions,
				globalQuats,
				preferredBias,
			});

			for (const dof of [ DOF.EX, DOF.EY, DOF.EZ ]) {
				const current = currentEuler[ dof - DOF.EX ];
				if (dof === primaryDof) {
					joint.setMinLimit(dof, current - 2.1);
					joint.setMaxLimit(dof, current + 2.1);
					joint.setRestPoseValue(dof, current + 0.16 * flexSign);
				} else {
					joint.setMinLimit(dof, current - 0.16);
					joint.setMaxLimit(dof, current + 0.16);
					joint.setRestPoseValue(dof, current);
				}
			}
			continue;
		}

		if (!activeTranslationIndices.has(index) && !activeRotationIndices.has(index)) {
			setRotationEnvelope(joint, currentEuler, [ 0.25, 0.25, 0.25 ]);
		}
	}
}

function buildIkSystem(payload) {
	const jointNames = payload.joint_names;
	const parents = payload.parents.map(v => Number(v));
	const globalPositions = payload.joints_pos.map(p => [ Number(p[ 0 ]), Number(p[ 1 ]), Number(p[ 2 ]) ]);
	const globalQuats = payload.joints_rot.map(matrixRows => rowMajorMat3ToQuat(matrixRows.flat()));
	const { children, rootIndex } = buildChildren(parents);
	if (rootIndex < 0) {
		throw new Error('No root joint found in payload.');
	}

	const metadata = jointNames.map((name, index) => ({
		index,
		name,
		parent: parents[ index ],
		children: children[ index ],
		...classifyJoint(name),
	}));
	const { localPositions, localQuats } = computeLocalPose(globalPositions, globalQuats, parents);
	const characterAxes = computeCharacterAxes(globalPositions, metadata);
	const controlState = buildControlState(payload, globalPositions, metadata);

	const jointFrames = new Array(jointNames.length);
	const linkFrames = new Array(jointNames.length);

	const rootJoint = new Joint();
	rootJoint.name = jointNames[ rootIndex ];
	rootJoint.setDoF(DOF.X, DOF.Y, DOF.Z, DOF.EX, DOF.EY, DOF.EZ);
	rootJoint.trackJointWrap = true;
	rootJoint.setPosition(0, 0, 0);
	rootJoint.setQuaternion(0, 0, 0, 1);
	const rootEuler = quatToEulerXYZ(localQuats[ rootIndex ]);
	rootJoint.setDoFValues(
		localPositions[ rootIndex ][ 0 ],
		localPositions[ rootIndex ][ 1 ],
		localPositions[ rootIndex ][ 2 ],
		rootEuler[ 0 ],
		rootEuler[ 1 ],
		rootEuler[ 2 ],
	);
	rootJoint.setRestPoseValues(
		localPositions[ rootIndex ][ 0 ],
		localPositions[ rootIndex ][ 1 ],
		localPositions[ rootIndex ][ 2 ],
		rootEuler[ 0 ],
		rootEuler[ 1 ],
		rootEuler[ 2 ],
	);
	const rootLink = new Link();
	rootLink.name = `${jointNames[ rootIndex ]}-link`;
	rootJoint.addChild(rootLink);
	jointFrames[ rootIndex ] = rootJoint;
	linkFrames[ rootIndex ] = rootLink;

	function attachChildren(parentIndex) {
		const parentLink = linkFrames[ parentIndex ];
		for (const childIndex of children[ parentIndex ]) {
			const joint = new Joint();
			joint.name = jointNames[ childIndex ];
			joint.trackJointWrap = true;
			joint.setPosition(
				localPositions[ childIndex ][ 0 ],
				localPositions[ childIndex ][ 1 ],
				localPositions[ childIndex ][ 2 ],
			);
			joint.setQuaternion(0, 0, 0, 1);
			joint.setDoF(DOF.EX, DOF.EY, DOF.EZ);
			const euler = quatToEulerXYZ(localQuats[ childIndex ]);
			joint.setDoFValues(euler[ 0 ], euler[ 1 ], euler[ 2 ]);
			joint.setRestPoseValues(euler[ 0 ], euler[ 1 ], euler[ 2 ]);

			const link = new Link();
			link.name = `${jointNames[ childIndex ]}-link`;
			parentLink.addChild(joint);
			joint.addChild(link);
			jointFrames[ childIndex ] = joint;
			linkFrames[ childIndex ] = link;
			attachChildren(childIndex);
		}
	}

	attachChildren(rootIndex);

	applyJointPolicies({
		jointFrames,
		metadata,
		children,
		parents,
		localPositions,
		localQuats,
		globalPositions,
		globalQuats,
		characterAxes,
		controlState,
	});

	const goalsByJoint = new Map();
	function getGoalConfig(index, controlName = '') {
		if (!goalsByJoint.has(index)) {
			goalsByJoint.set(index, {
				controlName,
				position: [ ...globalPositions[ index ] ],
				quaternion: quat.clone(globalQuats[ index ]),
				dofs: new Set(),
			});
		}
		const config = goalsByJoint.get(index);
		if (controlName && !config.controlName) {
			config.controlName = controlName;
		}
		return config;
	}

	for (const effector of controlState.effectors) {
		const config = getGoalConfig(effector.jointIndex, effector.controlName);
		config.position = effector.targetPosition.map(Number);
		config.dofs.add(DOF.X);
		config.dofs.add(DOF.Y);
		config.dofs.add(DOF.Z);
		if (effector.controlName === 'left_foot' || effector.controlName === 'right_foot') {
			config.dofs.add(DOF.EX);
			config.dofs.add(DOF.EY);
			config.dofs.add(DOF.EZ);
		}
	}

	for (const target of controlState.rotationTargets) {
		const config = getGoalConfig(target.jointIndex, target.controlName);
		config.quaternion = quat.clone(target.targetQuaternion);
		config.dofs.add(DOF.EX);
		config.dofs.add(DOF.EY);
		config.dofs.add(DOF.EZ);
	}

	for (const [ index, config ] of goalsByJoint.entries()) {
		const goal = new Goal();
		goal.name = `goal-${jointNames[ index ]}`;
		goal.setGoalDoF(...Array.from(config.dofs).sort((a, b) => a - b));
		goal.setPosition(config.position[ 0 ], config.position[ 1 ], config.position[ 2 ]);
		goal.setQuaternion(config.quaternion[ 0 ], config.quaternion[ 1 ], config.quaternion[ 2 ], config.quaternion[ 3 ]);
		goal.makeClosure(linkFrames[ index ]);
	}

	return { rootJoint, jointFrames };
}

function solveFramePayload(payload) {
	const { rootJoint, jointFrames } = buildIkSystem(payload);
	const solver = new Solver(rootJoint);
	solver.useSVD = false;
	solver.maxIterations = 72;
	solver.dampingFactor = 0.015;
	solver.restPoseFactor = 0.05;
	solver.translationFactor = 1.0;
	solver.rotationFactor = 0.75;
	solver.translationErrorClamp = 0.06;
	solver.rotationErrorClamp = 0.16;

	const status = solver.solve().map(code => SOLVE_STATUS_NAMES[ code ] ?? String(code));

	const jointsPos = [];
	const jointsRot = [];
	for (const joint of jointFrames) {
		const position = vec3.create();
		const q = quat.create();
		joint.getWorldPosition(position);
		joint.getWorldQuaternion(q);
		jointsPos.push([ position[ 0 ], position[ 1 ], position[ 2 ] ]);
		jointsRot.push(quatToRowMajorMat3(q));
	}

	return {
		joints_pos: jointsPos,
		joints_rot: jointsRot,
		status,
	};
}

function sendJson(res, statusCode, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(statusCode, {
		'Content-Type': 'application/json',
		'Content-Length': Buffer.byteLength(body),
	});
	res.end(body);
}

const server = http.createServer((req, res) => {
	if (req.method === 'GET' && req.url === '/healthz') {
		sendJson(res, 200, { ok: true });
		return;
	}

	if (req.method === 'POST' && req.url === '/solve/frame') {
		const chunks = [];
		req.on('data', chunk => chunks.push(chunk));
		req.on('end', () => {
			try {
				const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
				const solved = solveFramePayload(payload);
				sendJson(res, 200, solved);
			} catch (error) {
				sendJson(res, 500, {
					error: 'solve_failed',
					message: error instanceof Error ? error.message : String(error),
				});
			}
		});
		return;
	}

	sendJson(res, 404, { error: 'not_found' });
});

server.listen(PORT, HOST, () => {
	console.log(`Previz closed-chain-ik solver listening on http://${HOST}:${PORT}`);
});
