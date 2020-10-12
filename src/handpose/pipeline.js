const tf = require('@tensorflow/tfjs');
const bounding = require('./box');
const util = require('./util');

const UPDATE_REGION_OF_INTEREST_IOU_THRESHOLD = 0.8;
const PALM_BOX_SHIFT_VECTOR = [0, -0.4];
const PALM_BOX_ENLARGE_FACTOR = 3;
const HAND_BOX_SHIFT_VECTOR = [0, -0.1];
const HAND_BOX_ENLARGE_FACTOR = 1.65;
const PALM_LANDMARK_IDS = [0, 5, 9, 13, 17, 1, 2];
const PALM_LANDMARKS_INDEX_OF_PALM_BASE = 0;
const PALM_LANDMARKS_INDEX_OF_MIDDLE_FINGER_BASE = 2;

// The Pipeline coordinates between the bounding box and skeleton models.
class HandPipeline {
  constructor(boundingBoxDetector, meshDetector, meshWidth, meshHeight, maxContinuousChecks, detectionConfidence) {
    // An array of hand bounding boxes.
    this.regionsOfInterest = [];
    this.runsWithoutHandDetector = 0;
    this.boundingBoxDetector = boundingBoxDetector;
    this.meshDetector = meshDetector;
    this.maxContinuousChecks = maxContinuousChecks;
    this.detectionConfidence = detectionConfidence;
    this.meshWidth = meshWidth;
    this.meshHeight = meshHeight;
    this.maxHandsNumber = 1; // TODO(annxingyuan): Add multi-hand support.
  }

  // Get the bounding box surrounding the hand, given palm landmarks.
  getBoxForPalmLandmarks(palmLandmarks, rotationMatrix) {
    const rotatedPalmLandmarks = palmLandmarks.map((coord) => {
      const homogeneousCoordinate = [...coord, 1];
      return util.rotatePoint(homogeneousCoordinate, rotationMatrix);
    });
    const boxAroundPalm = this.calculateLandmarksBoundingBox(rotatedPalmLandmarks);
    // boxAroundPalm only surrounds the palm - therefore we shift it
    // upwards so it will capture fingers once enlarged + squarified.
    return bounding.enlargeBox(bounding.squarifyBox(bounding.shiftBox(boxAroundPalm, PALM_BOX_SHIFT_VECTOR)), PALM_BOX_ENLARGE_FACTOR);
  }

  // Get the bounding box surrounding the hand, given all hand landmarks.
  getBoxForHandLandmarks(landmarks) {
    // The MediaPipe hand mesh model is trained on hands with empty space
    // around them, so we still need to shift / enlarge boxAroundHand even
    // though it surrounds the entire hand.
    const boundingBox = this.calculateLandmarksBoundingBox(landmarks);
    const boxAroundHand = bounding.enlargeBox(bounding.squarifyBox(bounding.shiftBox(boundingBox, HAND_BOX_SHIFT_VECTOR)), HAND_BOX_ENLARGE_FACTOR);
    const palmLandmarks = [];
    for (let i = 0; i < PALM_LANDMARK_IDS.length; i++) {
      palmLandmarks.push(landmarks[PALM_LANDMARK_IDS[i]].slice(0, 2));
    }
    boxAroundHand.palmLandmarks = palmLandmarks;
    return boxAroundHand;
  }

  // Scale, rotate, and translate raw keypoints from the model so they map to
  // the input coordinates.
  transformRawCoords(rawCoords, box, angle, rotationMatrix) {
    const boxSize = bounding.getBoxSize(box);
    const scaleFactor = [boxSize[0] / this.meshWidth, boxSize[1] / this.meshHeight];
    const coordsScaled = rawCoords.map((coord) => [
      scaleFactor[0] * (coord[0] - this.meshWidth / 2),
      scaleFactor[1] * (coord[1] - this.meshHeight / 2), coord[2],
    ]);
    const coordsRotationMatrix = util.buildRotationMatrix(angle, [0, 0]);
    const coordsRotated = coordsScaled.map((coord) => {
      const rotated = util.rotatePoint(coord, coordsRotationMatrix);
      return [...rotated, coord[2]];
    });
    const inverseRotationMatrix = util.invertTransformMatrix(rotationMatrix);
    const boxCenter = [...bounding.getBoxCenter(box), 1];
    const originalBoxCenter = [
      util.dot(boxCenter, inverseRotationMatrix[0]),
      util.dot(boxCenter, inverseRotationMatrix[1]),
    ];
    return coordsRotated.map((coord) => [
      coord[0] + originalBoxCenter[0], coord[1] + originalBoxCenter[1],
      coord[2],
    ]);
  }

  async estimateHand(image, config) {
    const useFreshBox = this.shouldUpdateRegionsOfInterest();
    if (useFreshBox === true) {
      const boundingBoxPrediction = await this.boundingBoxDetector.estimateHandBounds(image);
      if (boundingBoxPrediction === null) {
        image.dispose();
        this.regionsOfInterest = [];
        return null;
      }
      this.updateRegionsOfInterest(boundingBoxPrediction, true /* force update */);
      this.runsWithoutHandDetector = 0;
    } else {
      this.runsWithoutHandDetector++;
    }
    // Rotate input so the hand is vertically oriented.
    const currentBox = this.regionsOfInterest[0];
    const angle = util.computeRotation(currentBox.palmLandmarks[PALM_LANDMARKS_INDEX_OF_PALM_BASE], currentBox.palmLandmarks[PALM_LANDMARKS_INDEX_OF_MIDDLE_FINGER_BASE]);
    const palmCenter = bounding.getBoxCenter(currentBox);
    const palmCenterNormalized = [palmCenter[0] / image.shape[2], palmCenter[1] / image.shape[1]];
    const rotatedImage = tf.image.rotateWithOffset(image, angle, 0, palmCenterNormalized);
    const rotationMatrix = util.buildRotationMatrix(-angle, palmCenter);
    // The bounding box detector only detects palms, so if we're using a fresh
    // bounding box prediction, we have to construct the hand bounding box from
    // the palm keypoints.
    const box = useFreshBox ? this.getBoxForPalmLandmarks(currentBox.palmLandmarks, rotationMatrix) : currentBox;
    const croppedInput = bounding.cutBoxFromImageAndResize(box, rotatedImage, [this.meshWidth, this.meshHeight]);
    const handImage = croppedInput.div(255);
    croppedInput.dispose();
    rotatedImage.dispose();
    let prediction;
    if (tf.getBackend() === 'webgl') {
      // Currently tfjs-core does not pack depthwiseConv because it fails for
      // very large inputs (https://github.com/tensorflow/tfjs/issues/1652).
      // TODO(annxingyuan): call tf.enablePackedDepthwiseConv when available
      // (https://github.com/tensorflow/tfjs/issues/2821)
      const savedWebglPackDepthwiseConvFlag = tf.env().get('WEBGL_PACK_DEPTHWISECONV');
      tf.env().set('WEBGL_PACK_DEPTHWISECONV', true);
      prediction = this.meshDetector.predict(handImage);
      tf.env().set('WEBGL_PACK_DEPTHWISECONV', savedWebglPackDepthwiseConvFlag);
    } else {
      prediction = this.meshDetector.predict(handImage);
    }
    const [flag, keypoints] = prediction;
    handImage.dispose();
    const flagValue = flag.dataSync()[0];
    flag.dispose();
    if (flagValue < config.minConfidence) {
      keypoints.dispose();
      this.regionsOfInterest = [];
      return null;
    }
    const keypointsReshaped = tf.reshape(keypoints, [-1, 3]);
    // Calling arraySync() because the tensor is very small so it's not worth
    // calling await array().
    const rawCoords = keypointsReshaped.arraySync();
    keypoints.dispose();
    keypointsReshaped.dispose();
    const coords = this.transformRawCoords(rawCoords, box, angle, rotationMatrix);
    const nextBoundingBox = this.getBoxForHandLandmarks(coords);
    this.updateRegionsOfInterest(nextBoundingBox, false /* force replace */);
    const result = {
      landmarks: coords,
      confidence: flagValue,
      box: {
        topLeft: nextBoundingBox.startPoint,
        bottomRight: nextBoundingBox.endPoint,
      },
    };
    return result;
  }

  // eslint-disable-next-line class-methods-use-this
  calculateLandmarksBoundingBox(landmarks) {
    const xs = landmarks.map((d) => d[0]);
    const ys = landmarks.map((d) => d[1]);
    const startPoint = [Math.min(...xs), Math.min(...ys)];
    const endPoint = [Math.max(...xs), Math.max(...ys)];
    return { startPoint, endPoint };
  }

  // Updates regions of interest if the intersection over union between
  // the incoming and previous regions falls below a threshold.
  updateRegionsOfInterest(box, forceUpdate) {
    if (forceUpdate) {
      this.regionsOfInterest = [box];
    } else {
      const previousBox = this.regionsOfInterest[0];
      let iou = 0;
      if (previousBox != null && previousBox.startPoint != null) {
        const [boxStartX, boxStartY] = box.startPoint;
        const [boxEndX, boxEndY] = box.endPoint;
        const [previousBoxStartX, previousBoxStartY] = previousBox.startPoint;
        const [previousBoxEndX, previousBoxEndY] = previousBox.endPoint;
        const xStartMax = Math.max(boxStartX, previousBoxStartX);
        const yStartMax = Math.max(boxStartY, previousBoxStartY);
        const xEndMin = Math.min(boxEndX, previousBoxEndX);
        const yEndMin = Math.min(boxEndY, previousBoxEndY);
        const intersection = (xEndMin - xStartMax) * (yEndMin - yStartMax);
        const boxArea = (boxEndX - boxStartX) * (boxEndY - boxStartY);
        const previousBoxArea = (previousBoxEndX - previousBoxStartX) * (previousBoxEndY - boxStartY);
        iou = intersection / (boxArea + previousBoxArea - intersection);
      }
      this.regionsOfInterest[0] = iou > UPDATE_REGION_OF_INTEREST_IOU_THRESHOLD ? previousBox : box;
    }
  }

  shouldUpdateRegionsOfInterest() {
    const roisCount = this.regionsOfInterest.length;
    return roisCount !== this.maxHandsNumber || this.runsWithoutHandDetector >= this.maxContinuousChecks;
  }
}
exports.HandPipeline = HandPipeline;