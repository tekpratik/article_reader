/**
 * @format
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import App from '../App';

jest.mock('react-native-sound', () => {
  const MockSound = jest.fn().mockImplementation((_file, _basePath, callback) => {
    callback?.(null);
    return {
      isLoaded: jest.fn(() => true),
      getDuration: jest.fn(() => 3.2),
      setVolume: jest.fn(),
      play: jest.fn(done => done(true)),
      stop: jest.fn(done => done?.()),
      release: jest.fn(),
    };
  });

  MockSound.setCategory = jest.fn();
  MockSound.setActive = jest.fn();

  return {
    __esModule: true,
    default: MockSound,
  };
});

jest.mock('react-native-fs', () => ({
  __esModule: true,
  default: {
    CachesDirectoryPath: '/tmp',
    exists: jest.fn(() => Promise.resolve(false)),
    stat: jest.fn(() => Promise.resolve({size: 1024})),
    unlink: jest.fn(() => Promise.resolve()),
    writeFile: jest.fn(() => Promise.resolve()),
  },
}));

test('renders correctly', async () => {
  await ReactTestRenderer.act(() => {
    ReactTestRenderer.create(<App />);
  });
});
