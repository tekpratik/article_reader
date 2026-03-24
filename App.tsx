import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
    ActivityIndicator,
    SafeAreaView,
    ScrollView,
    StatusBar,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    useWindowDimensions,
    View,
} from 'react-native';
import RenderHTML from 'react-native-render-html';
import RNFS from 'react-native-fs';
import Sound from 'react-native-sound';

const MAX_ARTICLE_CHARS = 12000;
const MAX_SPOKEN_CHARS = 3000;

const ELEVEN_API_KEY = '';
const VOICE_ID = 'EXAVITQu4vr4xnSDxMaL';
const AUDIO_FILE_NAME = 'article-reader-tts.mp3';
const AUDIO_FILE_PATH = `${RNFS.CachesDirectoryPath}/${AUDIO_FILE_NAME}`;

const isValidUrl = (value: string): boolean => {
    try {
        const parsed = new URL(value);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
        return false;
    }
};

const decodeHtmlEntities = (text: string): string =>
    text
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>');

const escapeHtml = (text: string): string =>
    text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

const stripHtml = (html: string): string =>
    decodeHtmlEntities(
        html
            .replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim(),
    );

const extractTitle = (html: string): string => {
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return stripHtml(titleMatch?.[1] || 'Untitled Article');
};

const extractParagraphs = (html: string): string[] => {
    const matches = [...html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)];
    return matches.map(m => stripHtml(m[1])).filter(Boolean);
};

const extractReadableContent = (html: string): string => {
    const paragraphs = extractParagraphs(html);
    if (paragraphs.length) {
        return paragraphs.join('\n\n').slice(0, MAX_ARTICLE_CHARS);
    }
    return stripHtml(html).slice(0, MAX_ARTICLE_CHARS);
};

const buildHtmlForDisplay = (title: string, text: string): string => {
    const paragraphs = text
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => `<p>${escapeHtml(line)}</p>`)
        .join('');

    return `<div><h1>${escapeHtml(title)}</h1>${paragraphs}</div>`;
};

const toBase64Audio = async (response: Response): Promise<string> => {
    const blob = await response.blob();

    return new Promise((resolve, reject) => {
        const reader = new FileReader();

        reader.onerror = () => reject(new Error('Could not read audio response'));
        reader.onloadend = () => {
            const dataUrl = reader.result;

            if (typeof dataUrl !== 'string') {
                reject(new Error('Invalid audio response'));
                return;
            }

            const base64 = dataUrl.split(',')[1];

            if (!base64) {
                reject(new Error('Missing audio data'));
                return;
            }

            resolve(base64);
        };

        reader.readAsDataURL(blob);
    });
};

const App: React.FC = () => {
    const [url, setUrl] = useState('');
    const [title, setTitle] = useState('');
    const [articleText, setArticleText] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState('');
    const [isSpeaking, setIsSpeaking] = useState(false);

    const soundRef = useRef<Sound | null>(null);
    const isMountedRef = useRef(true);
    const requestIdRef = useRef(0);
    const { width } = useWindowDimensions();

    const articleHtml = useMemo(() => {
        if (!articleText) return '';
        return buildHtmlForDisplay(title, articleText);
    }, [articleText, title]);

    useEffect(() => {
        Sound.setCategory('Playback');
        Sound.setActive(true);

        return () => {
            isMountedRef.current = false;

            if (soundRef.current) {
                soundRef.current.stop(() => {
                    soundRef.current?.release();
                    soundRef.current = null;
                });
            }
        };
    }, []);

    const stopSpeech = async (): Promise<void> => {
        requestIdRef.current += 1;

        if (soundRef.current) {
            await new Promise<void>(resolve => {
                soundRef.current?.stop(() => {
                    soundRef.current?.release();
                    soundRef.current = null;
                    resolve();
                });
            });
        }

        try {
            const exists = await RNFS.exists(AUDIO_FILE_PATH);
            if (exists) {
                await RNFS.unlink(AUDIO_FILE_PATH);
            }
        } catch {}

        if (isMountedRef.current) {
            setIsSpeaking(false);
        }
    };

    const playSpeech = async (text: string): Promise<void> => {
        if (!text) {
            setError('Load article first');
            return;
        }

        if (!ELEVEN_API_KEY.trim()) {
            setError('Add your ElevenLabs API key in App.tsx');
            return;
        }

        const requestId = requestIdRef.current + 1;
        requestIdRef.current = requestId;

        setError('');
        setIsSpeaking(true);

        try {
            await stopSpeech();
            requestIdRef.current = requestId;

            const response = await fetch(
                `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`,
                {
                    method: 'POST',
                    headers: {
                        'xi-api-key': ELEVEN_API_KEY,
                        'Content-Type': 'application/json',
                        Accept: 'audio/mpeg',
                    },
                    body: JSON.stringify({
                        text: text.slice(0, MAX_SPOKEN_CHARS),
                        model_id: 'eleven_flash_v2_5',
                        output_format: 'mp3_44100_128',
                        voice_settings: {
                            stability: 0.4,
                            similarity_boost: 0.8,
                        },
                    }),
                },
            );

            if (!response.ok) {
                const apiError = await response.text();
                throw new Error(apiError || `ElevenLabs request failed (${response.status})`);
            }

            const base64Audio = await toBase64Audio(response);

            if (requestId !== requestIdRef.current) {
                return;
            }

            await RNFS.writeFile(AUDIO_FILE_PATH, base64Audio, 'base64');
            const writtenFile = await RNFS.stat(AUDIO_FILE_PATH);

            if (!writtenFile.size || Number(writtenFile.size) === 0) {
                throw new Error('Audio file was empty');
            }

            if (requestId !== requestIdRef.current) {
                return;
            }

            const sound = await new Promise<Sound>((resolve, reject) => {
                const nextSound = new Sound(AUDIO_FILE_NAME, Sound.CACHES, loadError => {
                    if (loadError) {
                        reject(loadError);
                        return;
                    }

                    if (!nextSound.isLoaded() || nextSound.getDuration() <= 0) {
                        reject(new Error('Audio loaded with zero duration'));
                        return;
                    }

                    resolve(nextSound);
                });
            });

            if (requestId !== requestIdRef.current) {
                sound.release();
                return;
            }

            soundRef.current = sound;
            sound.setVolume(1);

            sound.play(success => {
                sound.release();

                if (soundRef.current === sound) {
                    soundRef.current = null;
                }

                if (!isMountedRef.current || requestId !== requestIdRef.current) {
                    return;
                }

                if (!success) {
                    setError('Playback failed');
                }

                setIsSpeaking(false);
            });
        } catch (e: any) {
            console.warn(e);

            if (isMountedRef.current && requestId === requestIdRef.current) {
                setError(e?.message || 'ElevenLabs failed');
                setIsSpeaking(false);
            }
        }
    };

    const loadArticle = async (): Promise<void> => {
        const trimmedUrl = url.trim();

        if (!isValidUrl(trimmedUrl)) {
            setError('Invalid URL');
            return;
        }

        setIsLoading(true);
        setError('');
        setTitle('');
        setArticleText('');
        await stopSpeech();

        try {
            const res = await fetch(trimmedUrl);
            const html = await res.text();

            setTitle(extractTitle(html));
            setArticleText(extractReadableContent(html));
        } catch (e: any) {
            setError(e.message || 'Failed to load');
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <SafeAreaView style={styles.safeArea}>
            <StatusBar barStyle="dark-content" backgroundColor="#f4f6fb" />

            <View style={styles.container}>
                <Text style={styles.heading}>📰 Article Reader</Text>

                <View style={styles.card}>
                    <TextInput
                        value={url}
                        onChangeText={setUrl}
                        placeholder="Enter article URL..."
                        style={styles.input}
                    />

                    <TouchableOpacity style={styles.primaryButton} onPress={loadArticle}>
                        <Text style={styles.primaryText}>
                            {isLoading ? 'Loading...' : 'Load Article'}
                        </Text>
                    </TouchableOpacity>
                </View>

                <View style={styles.audioRow}>
                    <TouchableOpacity
                        style={styles.secondaryButton}
                        onPress={() => {
                            playSpeech(articleText).catch(console.warn);
                        }}>
                        <Text>{isSpeaking ? '▶ Playing...' : '▶ Play'}</Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                        style={styles.secondaryButton}
                        onPress={() => {
                            stopSpeech().catch(console.warn);
                        }}>
                        <Text>⏹ Stop</Text>
                    </TouchableOpacity>
                </View>

                {isLoading && <ActivityIndicator style={styles.loader} />}
                {error ? <Text style={styles.error}>{error}</Text> : null}

                <ScrollView style={styles.articleContainer}>
                    {articleHtml ? (
                        <RenderHTML contentWidth={width} source={{ html: articleHtml }} />
                    ) : (
                        <Text style={styles.placeholder}>No content yet</Text>
                    )}
                </ScrollView>
            </View>
        </SafeAreaView>
    );
};

const styles = StyleSheet.create({
    safeArea: { flex: 1, backgroundColor: '#f4f6fb' },
    container: { flex: 1, padding: 16 },
    heading: { fontSize: 26, fontWeight: 'bold', marginBottom: 12 },

    card: {
        backgroundColor: '#fff',
        padding: 14,
        borderRadius: 12,
        elevation: 3,
    },

    input: {
        borderWidth: 1,
        borderColor: '#e0e0e0',
        borderRadius: 10,
        padding: 12,
    },

    primaryButton: {
        backgroundColor: '#007AFF',
        padding: 14,
        borderRadius: 10,
        alignItems: 'center',
        marginTop: 10,
    },

    primaryText: { color: '#fff', fontWeight: '600' },

    audioRow: { flexDirection: 'row', marginTop: 12 },

    secondaryButton: {
        flex: 1,
        backgroundColor: '#fff',
        padding: 14,
        marginHorizontal: 5,
        borderRadius: 10,
        alignItems: 'center',
        elevation: 2,
    },

    articleContainer: {
        marginTop: 12,
        backgroundColor: '#fff',
        borderRadius: 12,
        padding: 12,
    },

    loader: { marginTop: 10 },

    placeholder: { textAlign: 'center', color: '#888', marginTop: 20 },

    error: { color: 'red', marginTop: 10 },
});

export default App;
