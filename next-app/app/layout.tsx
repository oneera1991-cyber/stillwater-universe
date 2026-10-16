import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Stillwater with Vera',
  description: 'A quiet conversation with Vera. Cards, stories, and the things left unsaid.',
  openGraph: {
    title: 'Stillwater with Vera',
    description: 'A quiet conversation with Vera.',
    type: 'website',
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          href="https://fonts.googleapis.com/css2?family=Sarabun:wght@300;400;500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="bg-still-bg min-h-screen">
        {children}
      </body>
    </html>
  )
}
