package io.appfleet.control.catalogue;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface BaseImageRepository extends JpaRepository<BaseImage, UUID> {

    Optional<BaseImage> findByName(String name);

    @Query(value = """
        WITH RECURSIVE lineage as(
            SELECT id, name, registry, parent_base_image_id, 0 as depth
            FROM {h-schema}base_image
            WHERE id = :baseImageId
                
            UNION ALL
                
            SELECT parent.id, parent.name, parent.registry, parent.parent_base_image_id, lineage.depth + 1
            FROM {h-schema}base_image parent
            JOIN lineage ON lineage.parent_base_image_id = parent.id
        )
        SELECT  id, name, registry, parent_base_image_id FROM lineage ORDER BY depth  
        """, nativeQuery = true)
    List<BaseImage> findLineage(UUID baseImageId);
}
