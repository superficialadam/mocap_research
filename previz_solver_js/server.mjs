import http from 'node:http';
import { Goal, Joint, Link, Solver, DOF, SOLVE_STATUS_NAMES } from 'closed-chain-ik/src/index.js';
import { mat3, quat, vec3 } from 'gl-matrix';

const HOST = process.env.PREVIZ_SOLVER_HOST || '127.0.0.1';
const PORT = Number(process.env.PREVIZ_SOLVER_PORT || '8765');

function clamp(value, min, max) {
	return Math.min(max, Math.max(min, value));
}

function rowMajorMat3ToQuat(values) {
	const m = mat3.fromValues(
		values[0], values[3], values[6],
		values[1], values[4], values[7],
		values[2], values[5], values[8],
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
		[m[0], m[3], m[6]],
		[m[1], m[4], m[7]],
		[m[2], m[5], m[8]],
	];
}

function quatToEulerXYZ(q) {
	const [x, y, z, w] = q;
	const sinr = 2 * (w * x + y * z);
	const cosr = 1 - 2 * (x * x + y * y);
	const ex = Math.atan2(sinr, cosr);

	const sinp = clamp(2 * (w * y - z * x), -1, 1);
	const ey = Math.asin(sinp);

	const siny = 2 * (w * z + x * y);
	const cosy = 1 - 2 * (y * y + z * z);
	const ez = Math.atan2(siny, cosy);
	return [ex, ey, ez];
}

function wxyzToXyzw(values) {
	return [values[1], values[2], values[3], values[0]];
}

function buildChildren(parents) {
	const children = Array.from({ length: parents.length }, () => []);
	let rootIndex = -1;
	for (let i = 0; i < parents.length; i++) {
		const parent = parents[i];
		if (parent < 0) {
			if (rootIndex === -1) {
				rootIndex = i;
			}
			continue;
		}
		children[parent].push(i);
	}
	return { children, rootIndex };
}

function computeLocalPose(globalPositions, globalQuats, parents) {
	const localPositions = Array.from({ length: globalPositions.length }, () => [0, 0, 0]);
	const localQuats = Array.from({ length: globalQuats.length }, () => quat.create());
	for (let i = 0; i < globalPositions.length; i++) {
		const parent = parents[i];
		if (parent < 0) {
			localPositions[i] = [...globalPositions[i]];
			localQuats[i] = quat.clone(globalQuats[i]);
			continue;
		}

		const invParentQuat = quat.create();
		quat.invert(invParentQuat, globalQuats[parent]);

		const delta = vec3.fromValues(
			globalPositions[i][0] - globalPositions[parent][0],
			globalPositions[i][1] - globalPositions[parent][1],
			globalPositions[i][2] - globalPositions[parent][2],
		);
		vec3.transformQuat(delta, delta, invParentQuat);
		localPositions[i] = [delta[0], delta[1], delta[2]];

		const localQuat = quat.create();
		quat.multiply(localQuat, invParentQuat, globalQuats[i]);
		quat.normalize(localQuat, localQuat);
		localQuats[i] = localQuat;
	}
	return { localPositions, localQuats };
}

function buildIkSystem(payload) {
	const jointNames = payload.joint_names;
	const parents = payload.parents.map(v => Number(v));
	const globalPositions = payload.joints_pos.map(p => [Number(p[0]), Number(p[1]), Number(p[2])]);
	const globalQuats = payload.joints_rot.map(matrixRows => rowMajorMat3ToQuat(matrixRows.flat()));
	const { children, rootIndex } = buildChildren(parents);
	if (rootIndex < 0) {
		throw new Error('No root joint found in payload.');
	}

	const { localPositions, localQuats } = computeLocalPose(globalPositions, globalQuats, parents);
	const jointFrames = new Array(jointNames.length);
	const linkFrames = new Array(jointNames.length);

	const rootJoint = new Joint();
	rootJoint.name = jointNames[rootIndex];
	rootJoint.setDoF(DOF.X, DOF.Y, DOF.Z, DOF.EX, DOF.EY, DOF.EZ);
	rootJoint.trackJointWrap = true;
	rootJoint.setPosition(0, 0, 0);
	rootJoint.setQuaternion(0, 0, 0, 1);
	const rootEuler = quatToEulerXYZ(localQuats[rootIndex]);
	rootJoint.setDoFValues(
		localPositions[rootIndex][0],
		localPositions[rootIndex][1],
		localPositions[rootIndex][2],
		rootEuler[0],
		rootEuler[1],
		rootEuler[2],
	);
	rootJoint.setRestPoseValues(
		localPositions[rootIndex][0],
		localPositions[rootIndex][1],
		localPositions[rootIndex][2],
		rootEuler[0],
		rootEuler[1],
		rootEuler[2],
	);
	const rootLink = new Link();
	rootLink.name = `${jointNames[rootIndex]}-link`;
	rootJoint.addChild(rootLink);
	jointFrames[rootIndex] = rootJoint;
	linkFrames[rootIndex] = rootLink;

	function attachChildren(parentIndex) {
		const parentLink = linkFrames[parentIndex];
		for (const childIndex of children[parentIndex]) {
			const joint = new Joint();
			joint.name = jointNames[childIndex];
			joint.trackJointWrap = true;
			joint.setPosition(
				localPositions[childIndex][0],
				localPositions[childIndex][1],
				localPositions[childIndex][2],
			);
			joint.setQuaternion(0, 0, 0, 1);
			joint.setDoF(DOF.EX, DOF.EY, DOF.EZ);
			const euler = quatToEulerXYZ(localQuats[childIndex]);
			joint.setDoFValues(euler[0], euler[1], euler[2]);
			joint.setRestPoseValues(euler[0], euler[1], euler[2]);

			const link = new Link();
			link.name = `${jointNames[childIndex]}-link`;
			parentLink.addChild(joint);
			joint.addChild(link);
			jointFrames[childIndex] = joint;
			linkFrames[childIndex] = link;
			attachChildren(childIndex);
		}
	}

	attachChildren(rootIndex);

	const goalsByJoint = new Map();
	function getGoalConfig(index) {
		if (!goalsByJoint.has(index)) {
			goalsByJoint.set(index, {
				position: [...globalPositions[index]],
				quaternion: quat.clone(globalQuats[index]),
				dofs: new Set(),
			});
		}
		return goalsByJoint.get(index);
	}

	for (const effector of payload.effectors || []) {
		const index = Number(effector.joint_index);
		const config = getGoalConfig(index);
		config.position = effector.target_position.map(Number);
		config.dofs.add(DOF.X);
		config.dofs.add(DOF.Y);
		config.dofs.add(DOF.Z);
	}

	for (const target of payload.rotation_targets || []) {
		const index = Number(target.joint_index);
		const config = getGoalConfig(index);
		config.quaternion = quat.normalize(quat.create(), wxyzToXyzw(target.target_wxyz));
		config.dofs.add(DOF.EX);
		config.dofs.add(DOF.EY);
		config.dofs.add(DOF.EZ);
	}

	for (const [index, config] of goalsByJoint.entries()) {
		const goal = new Goal();
		goal.name = `goal-${jointNames[index]}`;
		goal.setGoalDoF(...Array.from(config.dofs).sort((a, b) => a - b));
		goal.setPosition(config.position[0], config.position[1], config.position[2]);
		goal.setQuaternion(config.quaternion[0], config.quaternion[1], config.quaternion[2], config.quaternion[3]);
		goal.makeClosure(linkFrames[index]);
	}

	return { rootJoint, jointFrames, rootIndex };
}

function solveFramePayload(payload) {
	const { rootJoint, jointFrames } = buildIkSystem(payload);
	const solver = new Solver(rootJoint);
	solver.useSVD = false;
	solver.maxIterations = 24;
	solver.dampingFactor = 0.01;
	solver.restPoseFactor = 0.025;
	solver.translationFactor = 1.0;
	solver.rotationFactor = 0.8;
	solver.translationErrorClamp = 0.08;
	solver.rotationErrorClamp = 0.2;

	const status = solver.solve().map(code => SOLVE_STATUS_NAMES[code] ?? String(code));

	const jointsPos = [];
	const jointsRot = [];
	for (const joint of jointFrames) {
		const position = vec3.create();
		const q = quat.create();
		joint.getWorldPosition(position);
		joint.getWorldQuaternion(q);
		jointsPos.push([position[0], position[1], position[2]]);
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
