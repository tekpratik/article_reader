import React, { useEffect, useMemo, useState } from 'react';
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
import Tts from 'react-native-tts';
import RenderHTML from 'react-native-render-html';

const MAX_ARTICLE_CHARS = 12000;
const MAX_SPOKEN_CHARS = 3000;

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
    const ogTitleMatch = html.match(
        /<meta[^>]+property=["']og:title["'][^>]+content=["']([\s\S]*?)["'][^>]*>/i,
    );

    return stripHtml(ogTitleMatch?.[1] || titleMatch?.[1] || 'Untitled Article');
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

    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    return stripHtml(bodyMatch?.[1] || html).slice(0, MAX_ARTICLE_CHARS);
};

const buildHtmlForDisplay = (title: string, text: string): string => {
    const paragraphs = text
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean)
        .map(l => `<p>${escapeHtml(l)}</p>`)
        .join('');

    return `<div><h1>${escapeHtml(title)}</h1>${paragraphs}</div>`;
};

const App: React.FC = () => {
    const [url, setUrl] = useState('');
    const [title, setTitle] = useState('');
    const [articleText, setArticleText] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState('');
    const [isSpeaking, setIsSpeaking] = useState(false);

    const { width } = useWindowDimensions();

    useEffect(() => {
        Tts.getInitStatus()
            .then(() => {
                Tts.setDefaultRate(0.5);
                Tts.setDefaultPitch(1.0);
                Tts.setIgnoreSilentSwitch('ignore');
            })
            .catch(() => {
                setError('TTS not available');
            });

        const onStart = () => setIsSpeaking(true);
        const onFinish = () => setIsSpeaking(false);
        const onCancel = () => setIsSpeaking(false);

        Tts.addEventListener('tts-start', onStart);
        Tts.addEventListener('tts-finish', onFinish);
        Tts.addEventListener('tts-cancel', onCancel);

        return () => {
            Tts.removeEventListener('tts-start', onStart);
            Tts.removeEventListener('tts-finish', onFinish);
            Tts.removeEventListener('tts-cancel', onCancel);
            Tts.stop();
        };
    }, []);

    const articleHtml = useMemo(() => {
        if (!articleText) return '';
        return buildHtmlForDisplay(title, articleText);
    }, [articleText, title]);

    const stopSpeech = (): void => {
        try {
            Tts.stop();
        } catch (e) {
            console.warn(e);
        } finally {
            setIsSpeaking(false);
        }
    };

    const playSpeech = (text: string): void => {
        if (!text) {
            setError('Load article first');
            return;
        }

        const textToSpeak = text.slice(0, MAX_SPOKEN_CHARS);

        try {
            if (isSpeaking) {
                Tts.stop();
            }

            Tts.speak(textToSpeak);
        } catch (e) {
            console.warn(e);
            setError('TTS failed');
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
        stopSpeech();

        try {
            const res = await fetch(trimmedUrl);
            const html = await res.text();

            const t = extractTitle(html);
            const content = extractReadableContent(html);

            if (!content) throw new Error('No content');

            setTitle(t);
            setArticleText(content);
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

                {/* INPUT CARD */}
                <View style={styles.card}>
                    <TextInput
                        value={url}
                        onChangeText={setUrl}
                        placeholder="Enter article URL..."
                        placeholderTextColor="#999"
                        style={styles.input}
                    />

                    <TouchableOpacity style={styles.primaryButton} onPress={loadArticle}>
                        <Text style={styles.primaryText}>
                            {isLoading ? 'Loading...' : 'Load Article'}
                        </Text>
                    </TouchableOpacity>
                </View>

                {/* AUDIO CONTROLS */}
                <View style={styles.audioRow}>
                    <TouchableOpacity
                        style={styles.secondaryButton}
                        onPress={() => playSpeech(articleText)}>
                        <Text style={styles.controlText}>▶ Play</Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                        style={styles.secondaryButton}
                        onPress={stopSpeech}>
                        <Text style={styles.controlText}>⏹ Stop</Text>
                    </TouchableOpacity>
                </View>

                {isLoading && <ActivityIndicator style={{ marginTop: 10 }} />}
                {error ? <Text style={styles.error}>{error}</Text> : null}

                {/* ARTICLE CARD */}
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
    safeArea: {
        flex: 1,
        backgroundColor: '#f4f6fb',
    },

    container: {
        flex: 1,
        padding: 16,
    },

    heading: {
        fontSize: 26,
        fontWeight: 'bold',
        marginBottom: 12,
    },

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
        backgroundColor: '#fafafa',
    },

    primaryButton: {
        backgroundColor: '#007AFF',
        padding: 14,
        borderRadius: 10,
        alignItems: 'center',
        marginTop: 10,
    },

    primaryText: {
        color: '#fff',
        fontWeight: '600',
    },

    audioRow: {
        flexDirection: 'row',
        marginTop: 12,
    },

    secondaryButton: {
        flex: 1,
        backgroundColor: '#fff',
        padding: 14,
        marginHorizontal: 5,
        borderRadius: 10,
        alignItems: 'center',
        elevation: 2,
    },

    controlText: {
        fontWeight: '500',
    },

    articleContainer: {
        marginTop: 12,
        backgroundColor: '#fff',
        borderRadius: 12,
        padding: 12,
    },

    placeholder: {
        textAlign: 'center',
        color: '#888',
        marginTop: 20,
    },

    error: {
        color: 'red',
        marginTop: 10,
    },
});

export default App;