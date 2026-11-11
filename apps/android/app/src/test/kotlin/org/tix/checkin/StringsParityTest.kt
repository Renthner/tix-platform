package org.tix.checkin

import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Element

/** English (default) and German string resources must define exactly the same keys. */
class StringsParityTest {
    // Unit tests run with the module directory (apps/android/app) as working directory.
    private val res = File("src/main/res")

    private fun keys(file: File): Set<String> {
        assertTrue("missing ${file.path}", file.exists())
        val doc = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(file)
        val out = sortedSetOf<String>()
        val nodes = doc.documentElement.childNodes
        for (i in 0 until nodes.length) {
            val el = nodes.item(i) as? Element ?: continue
            if (el.getAttribute("translatable") == "false") continue
            out += "${el.tagName}:${el.getAttribute("name")}"
        }
        return out
    }

    @Test
    fun `values and values-de have identical keys`() {
        val en = keys(File(res, "values/strings.xml"))
        val de = keys(File(res, "values-de/strings.xml"))
        assertTrue("no strings found", en.isNotEmpty())
        assertEquals("missing in de: ${en - de}, extra in de: ${de - en}", en, de)
    }

    @Test
    fun `format placeholders match between languages`() {
        fun placeholders(file: File): Map<String, List<String>> {
            val doc = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(file)
            val nodes = doc.documentElement.childNodes
            val out = sortedMapOf<String, List<String>>()
            for (i in 0 until nodes.length) {
                val el = nodes.item(i) as? Element ?: continue
                out[el.getAttribute("name")] = Regex("%\\d+\\$[sd]").findAll(el.textContent).map { it.value }.sorted().toList()
            }
            return out
        }
        assertEquals(
            placeholders(File(res, "values/strings.xml")),
            placeholders(File(res, "values-de/strings.xml")),
        )
    }
}
